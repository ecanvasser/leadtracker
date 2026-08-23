const BASE_URL = "https://app.getbonzo.com/api";

function getToken(): string {
  const token = process.env.BONZO_API_TOKEN;
  if (!token) throw new Error("BONZO_API_TOKEN not set");
  return token;
}

/**
 * Thrown on a 429 so callers can reschedule rather than burn a retry attempt.
 * Bonzo's OpenAPI document does not state a rate limit, so `retryAfterMs`
 * falls back to a conservative default when no Retry-After header is sent.
 */
export class BonzoRateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`Bonzo rate limit hit; retry in ${Math.round(retryAfterMs / 1000)}s`);
    this.name = "BonzoRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Thrown for a 4xx that will never succeed on retry. */
export class BonzoRequestError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, statusText: string, body: string) {
    super(`Bonzo API error: ${status} ${statusText}${body ? ` — ${body}` : ""}`);
    this.name = "BonzoRequestError";
    this.status = status;
    this.body = body;
  }
}

const DEFAULT_RETRY_AFTER_MS = 60_000;

interface BonzoFetchInit {
  method?: string;
  body?: unknown;
}

async function bonzoFetch(
  path: string,
  init: BonzoFetchInit = {}
): Promise<Response> {
  const hasBody = init.body !== undefined;
  const res = await fetch(`${BASE_URL}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: "application/json",
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
  });

  if (res.status === 401) {
    throw new Error("Bonzo authentication failed — check your API token");
  }

  if (res.status === 429) {
    const header = res.headers.get("retry-after");
    const seconds = header ? Number(header) : NaN;
    throw new BonzoRateLimitError(
      Number.isFinite(seconds) && seconds > 0
        ? seconds * 1000
        : DEFAULT_RETRY_AFTER_MS
    );
  }

  if (!res.ok) {
    // Read the body — Bonzo returns 422 validation detail that is otherwise
    // lost, and a silently swallowed send failure is the worst outcome here.
    const body = await res.text().catch(() => "");
    throw new BonzoRequestError(res.status, res.statusText, body.slice(0, 500));
  }

  return res;
}

/**
 * The mortgage sub-object on a prospect.
 *
 * Named `mortgage` in the API response, NOT `mortgage_fields`. The previous
 * interface declared `mortgage_fields`, a key Bonzo has never returned, so
 * every read of it was undefined and every draft was written with no loan
 * context at all. Field names below are transcribed from Bonzo's OpenAPI
 * document (ApiProspectResource -> mortgage).
 */
export interface BonzoMortgageFields {
  prospect_id?: number | null;
  lead_id?: string | null;
  company_name?: string | null;
  zip?: string | null;
  loan_amount?: string | null;
  down_payment?: string | null;
  loan_program?: string | null;
  credit_score?: string | null;
  loan_type?: string | null;
  loan_purpose?: string | null;
  property_value?: string | null;
  property_address?: string | null;
  property_unit_number?: string | null;
  property_city?: string | null;
  property_state?: string | null;
  property_zip?: string | null;
  property_county?: string | null;
  found_home?: number | null;
  bankruptcy?: number | null;
  [key: string]: unknown;
}

export interface BonzoTag {
  id: number;
  name: string;
  sequence_start?: string;
}

export interface BonzoProspect {
  id: number;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  phone_type?: string | null;
  status: string | null;
  /**
   * Bonzo's own pipeline fields are deliberately absent from this type AND
   * stripped from every response — see stripBonzoPipeline(). Eddie's rule is
   * that this app never reads or writes Bonzo pipelines, and D4 settles
   * conversion detection as "he moves the lead in LeadTracker", not as
   * mirroring Bonzo. Declaring the field would have made it available to the
   * next person who needed a shortcut; stripping it means it is not there to
   * reach for, and it never reaches insights_cache either.
   */
  /** Objects with id/name, not bare strings. */
  tags: BonzoTag[];
  /**
   * Campaigns the prospect is enrolled in. An array in the API, but
   * single-valued in practice — enrolment replaces rather than appends.
   */
  campaigns?: { id: number; name: string; sequence_start?: string }[];
  /** The real key. See BonzoMortgageFields. */
  mortgage: BonzoMortgageFields | null;

  /** Prospect's own IANA timezone — the best source for call scheduling. */
  timezone?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;

  /**
   * Compliance flags. This app sends SMS and email programmatically, so both
   * are checked before any send. Bonzo returns opt_outs as channel strings.
   */
  do_not_call?: boolean;
  opt_outs?: string[];

  last_contact?: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Reads the mortgage sub-object regardless of which key it arrived under.
 *
 * Rows cached before this fix hold only {id, name, email, phone}, and a very
 * old row could carry the imaginary `mortgage_fields` key. Both degrade to
 * null here rather than throwing; callers decide whether that is acceptable.
 */
export function getMortgageFields(
  prospect: Partial<BonzoProspect> | Record<string, unknown> | null | undefined
): BonzoMortgageFields | null {
  if (!prospect || typeof prospect !== "object") return null;
  const p = prospect as Record<string, unknown>;
  const candidate = p.mortgage ?? p.mortgage_fields;
  if (!candidate || typeof candidate !== "object") return null;
  const fields = candidate as BonzoMortgageFields;
  // An all-null mortgage object carries no more information than a missing one.
  const hasAnyValue = Object.entries(fields).some(
    ([k, v]) => k !== "prospect_id" && v !== null && v !== undefined && v !== ""
  );
  return hasAnyValue ? fields : null;
}

/** True when the prospect may not be contacted on the given channel. */
export function isOptedOut(
  prospect: Pick<BonzoProspect, "do_not_call" | "opt_outs"> | null | undefined,
  channel: "sms" | "email" | "call"
): boolean {
  if (!prospect) return false;
  if (channel === "call" && prospect.do_not_call) return true;
  const outs = (prospect.opt_outs ?? []).map((o) => String(o).toLowerCase());
  if (outs.length === 0) return false;
  if (outs.includes("all")) return true;
  if (channel === "sms") return outs.some((o) => o.includes("sms") || o.includes("text"));
  if (channel === "email") return outs.some((o) => o.includes("email"));
  return outs.some((o) => o.includes("call") || o.includes("voice"));
}

/**
 * Message direction, normalised.
 *
 * Bonzo returns "incoming" and "outgoing". The codebase was written against
 * "inbound"/"outbound", which Bonzo has never sent — so every direction check
 * silently matched nothing. That made detectUnansweredReply (the score-1000
 * signal), style exemplars, the "has he introduced himself" check and the
 * whole inbound-reply flow dead code against real data.
 *
 * Both vocabularies are accepted: fresh API responses use Bonzo's words, and
 * insights_cache holds historical payloads that may use either. Anything
 * unrecognised is neither — guessing would put a prospect's words into the
 * broker's voice profile.
 */
const INBOUND_WORDS = new Set(["incoming", "inbound", "in", "received"]);
const OUTBOUND_WORDS = new Set(["outgoing", "outbound", "out", "sent"]);

export function isInbound(direction: string | null | undefined): boolean {
  return INBOUND_WORDS.has(String(direction ?? "").trim().toLowerCase());
}

export function isOutbound(direction: string | null | undefined): boolean {
  return OUTBOUND_WORDS.has(String(direction ?? "").trim().toLowerCase());
}

export interface BonzoCommunication {
  id: number;
  content: string | null;
  direction: string;
  type: string;
  subject: string | null;
  status: string | null;
  created_at: string;
  user_name: string | null;
  source: string | null;
}

export interface BonzoNote {
  id: number;
  content: string;
  created_at: string;
  user_name: string | null;
}

/**
 * Removes Bonzo's pipeline fields from a prospect record.
 *
 * BonzoProspect carries an index signature, so dropping the field from the
 * type alone would not stop the data arriving — and refresh_cache persists the
 * whole prospect object into insights_cache.bonzo_prospect_data, so an
 * un-stripped response means Bonzo pipeline state lands in our database.
 * Enforced here at the boundary, which is the only place every read passes
 * through.
 */
export function stripBonzoPipeline<T>(prospect: T): T {
  if (!prospect || typeof prospect !== "object") return prospect;
  const copy = { ...(prospect as Record<string, unknown>) };
  delete copy.pipeline_stage;
  delete copy.pipeline;
  delete copy.pipeline_id;
  return copy as T;
}

/** Fetches one prospect by id — the authoritative full record. */
export async function getProspect(prospectId: number): Promise<BonzoProspect | null> {
  const res = await bonzoFetch(`/v3/prospects/${prospectId}`);
  const json = await res.json();
  const data = (json.data ?? json ?? null) as BonzoProspect | null;
  return data ? stripBonzoPipeline(data) : null;
}

/**
 * Finds a prospect by email and returns the complete record.
 *
 * The list response already carries the same fields as the single-prospect
 * response, but this re-reads by id so the object written into
 * insights_cache is unambiguously the full one. It runs only on enrollment
 * and manual refresh, never on the polling path, so the extra call is free
 * in practice.
 *
 * Note: `search` is not a documented query parameter on GET /v3/prospects —
 * only `order` is. It appears to work, but if Bonzo ever ignores it this
 * falls back to scanning the returned page, which would only match prospects
 * on page one. A miss here surfaces as "not found" rather than a wrong match.
 */
export async function searchProspectByEmail(
  email: string
): Promise<BonzoProspect | null> {
  const res = await bonzoFetch(
    `/v3/prospects?search=${encodeURIComponent(email)}`
  );
  const json = await res.json();
  const prospects: BonzoProspect[] = json.data ?? json ?? [];

  const match = prospects.find(
    (p) => p.email?.toLowerCase() === email.toLowerCase()
  );
  if (!match) return null;

  // Re-read by id so we always persist the complete record.
  const full = await getProspect(match.id).catch(() => null);
  return full ?? stripBonzoPipeline(match);
}

export async function getCommunicationHistory(
  prospectId: number
): Promise<BonzoCommunication[]> {
  const res = await bonzoFetch(`/v3/prospects/${prospectId}/communication`);
  const json = await res.json();
  return json.data ?? json ?? [];
}

export async function getProspectNotes(
  prospectId: number
): Promise<BonzoNote[]> {
  const res = await bonzoFetch(`/v3/prospects/${prospectId}/notes`);
  const json = await res.json();
  return json.data ?? json ?? [];
}

// ---------------------------------------------------------------------------
// Sending
//
// Endpoints and payload shapes transcribed from Bonzo's OpenAPI document:
//   POST /v3/prospects/{prospect}/sms    -> ApiProspectSmsRequest
//   POST /v3/prospects/{prospect}/email  -> ApiProspectEmailRequest
// Both return 200 with { data: ApiMessageResource }.
//
// Subject and body are separate fields on the email endpoint, which is why
// email_subject is its own column rather than a "Subject: ..." prefix packed
// into the message text.
// ---------------------------------------------------------------------------

/** The subset of ApiMessageResource a send actually needs to report. */
export interface BonzoSendResult {
  messageId: string;
  /** Bonzo's own delivery status for the message. */
  status: string;
  /** Populated by Bonzo when the send was accepted but then failed. */
  errorMessage: string | null;
  createdAt: string | null;
}

/**
 * Thrown when Bonzo accepts the request but reports the message itself failed.
 *
 * ApiMessageResource carries `status` and `error_message`, so a 200 is not on
 * its own proof of a send. Treating HTTP 2xx as success would mark a queue
 * item sent for a message that Bonzo knows never went out — which is exactly
 * the silent failure the spec asks not to have.
 */
export class BonzoSendRejectedError extends Error {
  readonly status: string;
  readonly messageId: string;
  constructor(status: string, messageId: string, detail: string | null) {
    super(
      `Bonzo accepted the request but reported the message ${status}` +
        (detail ? `: ${detail}` : "")
    );
    this.name = "BonzoSendRejectedError";
    this.status = status;
    this.messageId = messageId;
  }
}

/** Statuses Bonzo uses for a message that did not go out. */
const FAILED_STATUSES = new Set([
  "failed",
  "error",
  "undelivered",
  "rejected",
  "blocked",
  "bounced",
]);

function toSendResult(payload: unknown): BonzoSendResult {
  const data =
    (payload as { data?: Record<string, unknown> } | null)?.data ??
    (payload as Record<string, unknown> | null) ??
    {};

  const status = String(data.status ?? "");
  const messageId = String(data.id ?? "");
  const errorMessage =
    (data.error_message as string | null) ||
    (data.error_blurb as string | null) ||
    null;

  if (FAILED_STATUSES.has(status.toLowerCase())) {
    throw new BonzoSendRejectedError(status, messageId, errorMessage);
  }

  return {
    messageId,
    status,
    errorMessage,
    createdAt: (data.created_at as string | null) ?? null,
  };
}

export interface SendOptions {
  /**
   * Which Bonzo user the message is attributed to. Left unset by default so
   * Bonzo applies its own default rather than this app silently choosing.
   */
  sendAs?: "owner" | "me";
}

export async function sendSms(
  prospectId: number,
  message: string,
  options: SendOptions = {}
): Promise<BonzoSendResult> {
  const trimmed = message.trim();
  if (!trimmed) throw new Error("Refusing to send an empty SMS");

  const res = await bonzoFetch(`/v3/prospects/${prospectId}/sms`, {
    method: "POST",
    body: {
      message: trimmed,
      ...(options.sendAs ? { send_as: options.sendAs } : {}),
    },
  });

  return toSendResult(await res.json());
}

export async function sendEmail(
  prospectId: number,
  subject: string,
  message: string,
  options: SendOptions = {}
): Promise<BonzoSendResult> {
  const trimmedSubject = subject.trim();
  const trimmedMessage = message.trim();

  // Both are required by the endpoint; failing here gives a clearer error than
  // a 422 describing a field the caller never knew about.
  if (!trimmedSubject) throw new Error("Refusing to send an email with no subject");
  if (!trimmedMessage) throw new Error("Refusing to send an empty email");

  const res = await bonzoFetch(`/v3/prospects/${prospectId}/email`, {
    method: "POST",
    body: {
      subject: trimmedSubject,
      message: trimmedMessage,
      ...(options.sendAs ? { send_as: options.sendAs } : {}),
    },
  });

  return toSendResult(await res.json());
}

// ---------------------------------------------------------------------------
// Loan type mapping
// ---------------------------------------------------------------------------

/**
 * Maps Bonzo's loan fields onto our LoanType enum.
 *
 * Bonzo import previously hardcoded "purchase" for every lead, so a cash-out
 * refinance arrived labelled as a purchase and every draft written for it
 * reasoned from the wrong product.
 *
 * Bonzo sends free text here, and the same product is written several ways
 * across records, so matching is on normalised substrings rather than exact
 * values. `loan_purpose` is consulted as well because a record often carries
 * "Refinance" in loan_type and the distinction between rate-and-term and
 * cash-out only in loan_purpose.
 *
 * Returns null rather than guessing when nothing matches, so the caller can
 * decide — silently defaulting is what caused the original problem.
 */
export function mapBonzoLoanType(
  fields: Pick<BonzoMortgageFields, "loan_type" | "loan_purpose"> | null | undefined
): LoanTypeSlug | null {
  if (!fields) return null;

  const raw = [fields.loan_type, fields.loan_purpose].filter(Boolean).join(" ").toLowerCase();
  if (!raw.trim()) return null;

  // Two normalisations, because Bonzo writes the same product both ways.
  // "Cash-Out Refinance" needs punctuation turned into word breaks; "H.E.L.O.C."
  // needs it removed entirely, since breaking it gives "h e l o c".
  const spaced = raw.replace(/[^a-z0-9]+/g, " ").trim();
  const compact = raw.replace(/[^a-z0-9]+/g, "");

  if (!spaced) return null;

  // Order matters. Every rule here is a substring of a later one or shares
  // wording with it: "no cash out" contains "cash out", and "cash out
  // refinance" contains "refinance". The most specific reading wins.
  const rules: [RegExp, LoanTypeSlug][] = [
    // First, above every refinance rule. A reverse mortgage record legitimately
    // carries the word "refinance" (a HECM-to-HECM refi is still a HECM), and
    // the bare-refinance rule at the bottom would otherwise claim it. 'hecm' is
    // matched because Bonzo records use the acronym more often than the words.
    [/\breverse\b|\bhecm\b|\bhome equity conversion\b/, "reverse"],
    [/\bhard money\b|\bbridge\b|\bfix and flip\b/, "hard_money"],
    [/\bheloc\b|\bhome equity line\b|\bequity line\b/, "heloc"],
    [/\bhe loan\b|\bheloan\b|\bhome equity loan\b/, "heloan"],
    [/\bhei\b|\bequity investment\b|\bshared equity\b/, "hei"],
    [/\bfast 50\b|\bfast50\b/, "fast_50"],
    // Before the cash-out rule: "no cash out" is rate-and-term, and it
    // contains the words the next rule looks for.
    [/\bno cash out\b|\bwithout cash out\b/, "rate_term"],
    [/\bcash out\b|\bcashout\b/, "cashout"],
    [/\brate and term\b|\brate term\b/, "rate_term"],
    // A bare refinance with no cash-out signal is rate-and-term.
    [/\brefi\b|\brefinance\b/, "rate_term"],
    [/\bpurchase\b|\bbuy\b/, "purchase"],
  ];

  for (const [pattern, slug] of rules) {
    if (pattern.test(spaced)) return slug;
  }

  // Nothing matched the spaced form — retry against the compact one to catch
  // acronyms written with separators.
  for (const [pattern, slug] of rules) {
    if (pattern.test(compact)) return slug;
  }

  return null;
}

/** Kept local so the Bonzo client does not import from types/db. */
export type LoanTypeSlug =
  | "cashout"
  | "rate_term"
  | "heloc"
  | "heloan"
  | "hei"
  | "purchase"
  | "hard_money"
  | "fast_50"
  | "reverse";

/** One campaign, as the workflow builder's dropdown needs it. */
export interface BonzoCampaign {
  id: number;
  name: string;
  prospects_count?: string;
  sequence?: { id: number; name: string; enabled?: boolean } | null;
}

/**
 * Every campaign, following pagination.
 *
 * /v3/campaigns returns 25 per page and this account has 35, so an unpaginated
 * read silently reports a truncated list — which in the builder's dropdown
 * means a campaign Eddie needs is simply absent, with no error to explain it.
 *
 * Requires the `campaigns` token scope. The original LeadTracker token did not
 * carry it and this 403s without it, so the caller surfaces that specifically
 * rather than showing an empty dropdown.
 */
export async function listCampaigns(): Promise<BonzoCampaign[]> {
  const all: BonzoCampaign[] = [];

  // Bounded rather than while(true): a malformed meta block must not spin.
  for (let page = 1; page <= 50; page++) {
    const res = await bonzoFetch(`/v3/campaigns?page=${page}`);
    const json = await res.json();
    const rows: BonzoCampaign[] = json.data ?? [];
    all.push(...rows);

    const last = json.meta?.last_page;
    if (!rows.length || !last || page >= last) break;
  }

  return all;
}

/**
 * Moves a prospect into a campaign.
 *
 * REPLACES rather than appends — proven by live probe, and named "Move to
 * campaign" for that reason. That is the intended behaviour: Eddie's campaigns
 * are a state machine mirroring his pipeline and a prospect sits in exactly
 * one, so moving campaigns *is* the transition. It does mean the previous
 * enrolment is lost unless the caller recorded it first, which is what
 * workflow_runs.displaced is for.
 *
 * Requires the `campaigns` token scope.
 */
export async function moveProspectToCampaign(
  prospectId: number,
  campaignId: number
): Promise<void> {
  await bonzoFetch(`/v3/prospects/${prospectId}/campaign/${campaignId}`, {
    method: "POST",
  });
}

/**
 * The campaign a prospect is currently in, or null.
 *
 * Read before a move so the displaced campaign can be recorded and put back.
 * The API returns an array, but enrolment is single-valued in practice; the
 * first entry is taken and the whole array is preserved by the caller.
 */
export function currentCampaign(
  prospect: Pick<BonzoProspect, "campaigns"> | null | undefined
): { id: number; name: string } | null {
  const list = prospect?.campaigns;
  if (!Array.isArray(list) || list.length === 0) return null;
  const first = list[0] as { id?: number; name?: string };
  if (typeof first?.id !== "number") return null;
  return { id: first.id, name: first.name ?? String(first.id) };
}
