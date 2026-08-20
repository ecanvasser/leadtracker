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

export interface BonzoPipelineStage {
  id: number;
  name: string;
  pipeline_id: number;
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
  /** An object in the API, not a string. */
  pipeline_stage: BonzoPipelineStage | null;
  /** Objects with id/name, not bare strings. */
  tags: BonzoTag[];
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

/** Fetches one prospect by id — the authoritative full record. */
export async function getProspect(prospectId: number): Promise<BonzoProspect | null> {
  const res = await bonzoFetch(`/v3/prospects/${prospectId}`);
  const json = await res.json();
  return (json.data ?? json ?? null) as BonzoProspect | null;
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
  return full ?? match;
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
