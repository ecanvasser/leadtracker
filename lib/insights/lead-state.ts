/**
 * Lead state classification — the "why" layer.
 *
 * Phase 7 repurposed this from a general lead taxonomy to a post-pitch one.
 * Classification now runs only for leads in Quoted – Follow Up, because that
 * is the only stage QUEUE_ELIGIBLE_STAGES covers: everything earlier Eddie
 * works by hand and already understands. The question is no longer "how warm
 * is this lead" but "they have heard the number — what did they do with it".
 *
 * The machinery is unchanged and so are the two rules that make it
 * trustworthy rather than decorative. Both are enforced here in code rather
 * than merely requested in the prompt:
 *
 * 1. A read of the lead must be backed by a verbatim quote from the pulled
 *    history. If the quote is not actually there, the read is discarded and
 *    the lead falls back to no_response at low confidence. This matters more
 *    now than it did before: a hallucinated "soft_no" can hand a live deal to
 *    a cold campaign under Eddie's name.
 *
 * 2. Doing nothing is a valid outcome. `hold` stays in the action set.
 *
 * Note on what this does NOT produce: there is no draft. The output is a
 * suggested_angle — one line naming what to lead with. Eddie writes the
 * message. That is the whole of section 3.2, and it replaces a drafting
 * subsystem that cost roughly four times as much.
 */

import { callModel, type ModelUsage } from "@/lib/ai/models";
import {
  getMortgageFields,
  isInbound,
  isOutbound,
  messagesOnly,
  type CommunicationLike,
  type BonzoProspect,
} from "@/lib/bonzo/client";

/**
 * What the lead did with the number after being pitched.
 *
 * Ordered roughly from least to most engaged. `no_response` is the honest
 * default and the fallback whenever evidence cannot be verified.
 */
export const PITCH_RESPONSES = [
  "no_response",
  "soft_no",
  "price_objection",
  "timing_objection",
  "competitor",
  "needs_info",
  "positive_intent",
  "converted_signal",
] as const;
export type PitchResponse = (typeof PITCH_RESPONSES)[number];

/**
 * What to do next.
 *
 * - follow_up — surface a card; Eddie writes the message.
 * - hold      — do nothing. Still a valid, deliberate answer.
 * - hand_off  — pass to a Bonzo nurture campaign and stop working individually.
 * - convert   — they are moving; this belongs in App In.
 *
 * `convert` is advisory only. D4 settles conversion detection as Eddie moving
 * the lead in LeadTracker; nothing in the system acts on this value on its
 * own, and nothing should start.
 */
export const RECOMMENDED_ACTIONS = [
  "follow_up",
  "hold",
  "hand_off",
  "convert",
] as const;
export type RecommendedAction = (typeof RECOMMENDED_ACTIONS)[number];

/** Reads that assert something specific happened, and therefore need a quote. */
const EVIDENCE_REQUIRED: readonly PitchResponse[] = PITCH_RESPONSES.filter(
  (r) => r !== "no_response"
);

/** Actions too consequential to take on unverified evidence. */
const EVIDENCE_GATED_ACTIONS: readonly RecommendedAction[] = [
  "hand_off",
  "convert",
];

export interface LeadState {
  pitch_response: PitchResponse;
  /** Verbatim quote from the Bonzo history. Null when there is none. */
  evidence: string | null;
  evidence_confidence: "high" | "medium" | "low";
  /**
   * One line naming what to lead with — not a draft message.
   * "She asked about closing costs, not rate — lead with the credit."
   */
  suggested_angle: string;
  /** Computed from the history, never taken from the model. */
  last_inbound_at: string | null;
  /** Computed from the history, never taken from the model. */
  last_outbound_at: string | null;
  /**
   * Days since the lead entered Quoted – Follow Up. Computed from
   * contacts.stage_changed_at; null when that is unknown, which is honest
   * rather than a guess. Never taken from the model.
   */
  days_since_pitch: number | null;
  recommended_action: RecommendedAction;
  /**
   * Kept from the pre-Phase-7 shape although section 3.1 does not list it.
   * The cadence engine and the snooze paths both read it, and dropping it
   * would silently un-suppress every snoozed lead.
   */
  suppress_until: string | null;
}

/**
 * What the model is asked for.
 *
 * Deliberately smaller than LeadState: the three computed fields
 * (last_inbound_at, last_outbound_at, days_since_pitch) are facts we can
 * derive, so asking for them would spend tokens on values that get
 * overwritten — and would invite a plausible-looking wrong one into an
 * audit trail.
 */
export const LEAD_STATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    pitch_response: { type: "string", enum: [...PITCH_RESPONSES] },
    evidence: {
      type: ["string", "null"],
      description:
        "A verbatim quote from the message history that evidences the pitch_response, copied exactly, with its date. Null if there is no such quote.",
    },
    evidence_confidence: { type: "string", enum: ["high", "medium", "low"] },
    suggested_angle: {
      type: "string",
      description:
        "One line: what to lead with when following up. Not a message, not a greeting — the angle only.",
    },
    recommended_action: { type: "string", enum: [...RECOMMENDED_ACTIONS] },
    suppress_until: {
      type: ["string", "null"],
      description: "ISO date before which this lead should not be contacted.",
    },
  },
  required: [
    "pitch_response",
    "evidence",
    "evidence_confidence",
    "suggested_angle",
    "recommended_action",
    "suppress_until",
  ],
  additionalProperties: false,
};

const CLASSIFY_SYSTEM = `You classify what a mortgage lead did after they were quoted a number, so the broker can see why a lead surfaced and decide whether to trust it.

Every lead you see has already been pitched. They have heard the rate, the payment, or the cash-out figure. The only question is what happened next, and there are only a few real answers: they went quiet, they pushed back on price, they pushed back on timing, they went to a competitor, they want more information, they sounded interested, or they are moving forward.

Rules you must follow:

EVIDENCE. If you report anything other than "no_response", the evidence field must be a quote copied EXACTLY from the message history you were given — the same characters, not a paraphrase or a summary. Include its date. If you cannot find such a quote, set pitch_response to "no_response" and evidence_confidence to "low".

This rule is the whole reason this output can be trusted. A wrong guess here does not just look silly — it can hand a live deal to a cold nurture campaign under the broker's own name, or stop him chasing someone who was about to sign. An honest "no_response" is always better than a confident invention.

DOING NOTHING IS A VALID ANSWER. If nothing has changed and there is no reason to make contact, recommended_action is "hold". Do not manufacture a reason. A pointless "just checking in" on a lead who is thinking is the failure mode this system exists to prevent.

SUGGESTED_ANGLE IS NOT A MESSAGE. One line naming what to lead with, addressed to the broker, not to the prospect. "She asked about closing costs, not rate — lead with the lender credit." Not "Hi Dana, I wanted to follow up...". He writes the message himself; you tell him what to raise. If you have nothing specific, say what is missing rather than filling the space.

Return only the JSON object.`;

export interface ClassifyInput {
  prospect: BonzoProspect | Record<string, unknown> | null;
  communications: {
    content: string | null;
    direction: string;
    type: string;
    created_at: string;
    /** Distinguishes Bonzo's audit entries from messages. See isRealMessage. */
    source?: string | null;
  }[];
  notes?: { content: string; created_at: string }[];
  leadAgeDays: number;
  /** Today in the broker's timezone, so the model reasons about the right day. */
  todayLocal: string;
  /**
   * When the lead entered Quoted – Follow Up, from contacts.stage_changed_at.
   * Drives days_since_pitch. Undefined for leads that moved into the stage
   * before that column existed.
   */
  quotedAt?: string | null;
}

export interface ClassifyResult {
  state: LeadState;
  usage: ModelUsage;
  /** Set when a claimed quote was not found and the read was discarded. */
  evidenceRejected: boolean;
}

/**
 * Normalizes text for quote comparison.
 *
 * Whitespace and smart punctuation differ freely between what the model echoes
 * and what Bonzo stored, and rejecting on those would discard true evidence.
 * Everything else must match exactly.
 */
export function normalizeQuote(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether a claimed quote genuinely appears in the history.
 *
 * The model is asked for an exact quote; a leading date stamp it added is
 * tolerated, but the substance has to be present.
 */
export function quoteAppearsInHistory(
  quote: string,
  communications: { content: string | null }[]
): boolean {
  const cleaned = normalizeQuote(stripLeadingDate(quote));
  if (cleaned.length < 8) return false;

  const haystack = communications
    .map((c) => normalizeQuote(c.content ?? ""))
    .filter(Boolean);

  return haystack.some((h) => h.includes(cleaned));
}

/** Removes a "[2026-08-18]" or "2026-08-18:" prefix the model may prepend. */
export function stripLeadingDate(quote: string): string {
  return quote
    .replace(/^\s*[[(]?\s*\d{4}-\d{2}-\d{2}[^\]\):]*[\])]?\s*[:\-–—]?\s*/, "")
    .trim();
}

/**
 * Applies the rules that make this record trustworthy.
 *
 * Runs after every classification, including cached or hand-edited records, so
 * the invariants hold regardless of where the state came from.
 */
export function enforceLeadStateRules(
  raw: LeadState,
  communications: { content: string | null }[]
): { state: LeadState; evidenceRejected: boolean } {
  const state: LeadState = { ...raw };
  let evidenceRejected = false;

  // Rule 1: no specific read without a verifiable quote.
  if (EVIDENCE_REQUIRED.includes(state.pitch_response)) {
    const quote = state.evidence;
    if (!quote || !quoteAppearsInHistory(quote, communications)) {
      evidenceRejected = true;
      state.pitch_response = "no_response";
      state.evidence = null;
      state.evidence_confidence = "low";
    }
  }

  // "No response" cannot be a high-confidence reading of anything.
  if (state.pitch_response === "no_response" && state.evidence_confidence === "high") {
    state.evidence_confidence = "low";
  }

  /*
   * Rule 2: the two consequential actions require evidence that survived.
   *
   * hand_off starts real messaging under Eddie's name and is awkward to undo;
   * convert stops him chasing someone. Neither is a decision to take on a
   * quote that turned out not to exist. Downgrading to follow_up surfaces the
   * lead to a human instead of acting on a hallucination.
   *
   * This does not stop the 2-day rule from handing anyone off — that is a
   * workflow firing on elapsed time, which is observable fact rather than a
   * model's reading.
   */
  if (evidenceRejected && EVIDENCE_GATED_ACTIONS.includes(state.recommended_action)) {
    state.recommended_action = "follow_up";
  }

  // Rule 3: a suppression date in the future overrides any outreach.
  if (state.suppress_until && isFutureDate(state.suppress_until)) {
    state.recommended_action = "hold";
  }

  return { state, evidenceRejected };
}

function isFutureDate(iso: string): boolean {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t > Date.now();
}

function buildClassifyMessage(input: ClassifyInput): string {
  const mf = getMortgageFields(input.prospect);
  const parts: string[] = [`Today is ${input.todayLocal}. Lead age: ${input.leadAgeDays} days.`];

  const days = daysSincePitch(input.quotedAt, input.todayLocal);
  parts.push(
    days === null
      ? "Days since the quote was sent: unknown."
      : `Days since the quote was sent: ${days}.`
  );

  if (mf) {
    const fields = Object.entries(mf)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    if (fields) parts.push(`LOAN FILE:\n${fields}`);
  } else {
    parts.push("LOAN FILE: no mortgage details on record.");
  }

  const threadMessages = messagesOnly(input.communications);
  if (threadMessages.length > 0) {
    // "Person moved to <campaign> campaign" is not something the lead said,
    // and a classifier that quotes it as evidence would be quoting the app to
    // itself. The evidence gate compares against this same filtered thread.
    const sorted = [...threadMessages].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    const thread = sorted
      .map((c) => {
        const who = isOutbound(c.direction) ? "BROKER" : "PROSPECT";
        return `[${c.created_at.slice(0, 10)}] ${who}: ${c.content?.trim() || "(no content)"}`;
      })
      .join("\n");
    parts.push(
      `MESSAGE HISTORY (oldest to newest). Any quote you use as evidence must be copied exactly from here:\n${thread}`
    );
  } else {
    parts.push("MESSAGE HISTORY: none. No message has been exchanged.");
  }

  if (input.notes?.length) {
    parts.push(
      `INTERNAL NOTES:\n${input.notes.map((n) => `[${n.created_at.slice(0, 10)}] ${n.content}`).join("\n")}`
    );
  }

  return parts.join("\n\n");
}

/**
 * Whole days between the pitch and today.
 *
 * Null rather than zero when the pitch date is unknown: a lead that moved into
 * Quoted – Follow Up before stage_changed_at existed genuinely has no pitch
 * date, and reporting "0 days since pitch" would read as "just pitched" and
 * suppress exactly the follow-up that is overdue.
 */
export function daysSincePitch(
  quotedAt: string | null | undefined,
  todayLocal: string
): number | null {
  if (!quotedAt) return null;
  const start = new Date(quotedAt).getTime();
  const now = new Date(`${todayLocal}T00:00:00Z`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(now)) return null;
  const startDay = new Date(quotedAt).toISOString().slice(0, 10);
  const diff =
    (Date.parse(`${todayLocal}T00:00:00Z`) - Date.parse(`${startDay}T00:00:00Z`)) /
    86_400_000;
  return Number.isFinite(diff) ? Math.max(0, Math.round(diff)) : null;
}

/**
 * Hours between scheduled classifications. Twice daily (spec 3.3).
 *
 * The cache refresh stays on its 15-minute schedule — reading Bonzo is free
 * and reply and opt-out detection need to be fast. Only the thinking is
 * rationed, which is the whole shape of the cost model: refreshing is free,
 * thinking about it costs money.
 */
export const CLASSIFY_INTERVAL_HOURS = 12;

/**
 * Whether a lead is due for classification.
 *
 * Assumes the caller has already established that something is new — the
 * hasNewMessages guard runs first and returns before this is reached, so a
 * poll that found nothing never gets here and never spends a token.
 *
 * Three cases, in order:
 *
 *   - Never classified. Classify; there is nothing to show on the card yet.
 *   - A new inbound reply. Classify immediately — that is the moment the
 *     picture changes, and waiting up to twelve hours to notice someone
 *     answered is the opposite of what this is for.
 *   - Otherwise, twice daily. New outbound activity alone is Eddie sending
 *     something; it does not change what the lead thinks.
 */
export function shouldClassify(opts: {
  hasNewInbound: boolean;
  lastClassifiedAt: string | null | undefined;
  now?: Date;
  intervalHours?: number;
}): { classify: boolean; reason: string } {
  const { hasNewInbound, lastClassifiedAt } = opts;
  const now = opts.now ?? new Date();
  const intervalHours = opts.intervalHours ?? CLASSIFY_INTERVAL_HOURS;

  if (!lastClassifiedAt) return { classify: true, reason: "never_classified" };
  if (hasNewInbound) return { classify: true, reason: "new_inbound" };

  const last = new Date(lastClassifiedAt).getTime();
  if (!Number.isFinite(last)) {
    // An unparseable timestamp is treated as never classified rather than as
    // "recently classified" — failing towards a known-good record.
    return { classify: true, reason: "unreadable_timestamp" };
  }

  const hoursSince = (now.getTime() - last) / 3_600_000;
  return hoursSince >= intervalHours
    ? { classify: true, reason: "interval_elapsed" }
    : { classify: false, reason: "classified_recently" };
}

/** Classifies one lead. Uses the analysis model — this is the judgment step. */
export async function classifyLeadState(
  input: ClassifyInput
): Promise<ClassifyResult> {
  const result = await callModel<LeadState>({
    role: "analysis",
    system: CLASSIFY_SYSTEM,
    schema: LEAD_STATE_SCHEMA,
    maxTokens: 4096,
    messages: [{ role: "user", content: buildClassifyMessage(input) }],
  });

  if (result.truncated) throw new Error("Lead state response was truncated");
  if (!result.parsed) throw new Error("Lead state response could not be parsed");

  const { state, evidenceRejected } = enforceLeadStateRules(
    withObservedFacts(result.parsed, input),
    messagesOnly(input.communications)
  );

  return { state, usage: result.usage, evidenceRejected };
}

/**
 * Overwrites every field we can observe with what the record actually shows.
 *
 * These are facts, not judgments. There is no reason to trust a model to
 * transcribe them, and a wrong one silently distorts both the queue's ordering
 * and any workflow trigger that reads them.
 */
export function withObservedFacts(
  state: LeadState,
  input: {
    // Only the two fields actually read, so callers and tests are not forced
    // to construct a full ClassifyInput to compute a timestamp.
    communications: CommunicationLike[];
    quotedAt?: string | null;
    todayLocal: string;
  }
): LeadState {
  // Audit entries are outgoing and would otherwise become last_outbound_at,
  // making a lead look freshly touched when nothing was sent. See
  // isRealMessage.
  const messages = messagesOnly(input.communications);
  const latest = (match: (d: string) => boolean): string | null => {
    const times = messages
      .filter((c) => match(c.direction))
      .map((c) => new Date(c.created_at).getTime())
      .filter((t) => Number.isFinite(t));
    if (times.length === 0) return null;
    return new Date(Math.max(...times)).toISOString();
  };

  return {
    ...state,
    last_inbound_at: latest(isInbound),
    last_outbound_at: latest(isOutbound),
    days_since_pitch: daysSincePitch(input.quotedAt, input.todayLocal),
  };
}
