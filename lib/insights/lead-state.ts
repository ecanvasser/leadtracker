/**
 * Lead state classification — the "why" layer.
 *
 * Produces a structured, auditable record of what the engine believes about a
 * lead and what it intends to do. Two rules make this trustworthy rather than
 * decorative, and both are enforced here in code rather than requested in the
 * prompt:
 *
 * 1. A blocker must be backed by a verbatim quote from the pulled history. If
 *    the quote is not actually in the history, the blocker is discarded.
 *    "Unknown" is more useful than a confident guess.
 *
 * 2. A blocked lead with no fired trigger is held, not messaged. The engine is
 *    allowed — required — to recommend doing nothing.
 */

import { callModel, type ModelUsage } from "@/lib/ai/models";
import { getMortgageFields, type BonzoProspect } from "@/lib/bonzo/client";

export const LEAD_TEMPS = [
  "in_market",
  "warming",
  "stalled",
  "blocked",
  "unresponsive",
] as const;
export type LeadTemp = (typeof LEAD_TEMPS)[number];

export const BLOCKERS = [
  "none",
  "prior_denial",
  "credit",
  "equity",
  "income",
  "dti",
  "property",
  "timing",
  "rate_shopping",
  "competitor",
  "non_responsive",
] as const;
export type Blocker = (typeof BLOCKERS)[number];

export const RECOMMENDED_ACTIONS = ["sms", "email", "call", "hold"] as const;
export type RecommendedAction = (typeof RECOMMENDED_ACTIONS)[number];

export interface LeadState {
  lead_temp: LeadTemp;
  blocker: Blocker;
  /** Verbatim quote from the Bonzo history, with its date. */
  blocker_evidence: string | null;
  blocker_confidence: "high" | "medium" | "low";
  unblock_path: string | null;
  unblock_trigger: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  recommended_action: RecommendedAction;
  why_now: string;
  suppress_until: string | null;
}

export const LEAD_STATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    lead_temp: { type: "string", enum: [...LEAD_TEMPS] },
    blocker: { type: "string", enum: [...BLOCKERS] },
    blocker_evidence: {
      type: ["string", "null"],
      description:
        "A verbatim quote from the message history that evidences the blocker, copied exactly, with its date. Null if there is no such quote.",
    },
    blocker_confidence: { type: "string", enum: ["high", "medium", "low"] },
    unblock_path: {
      type: ["string", "null"],
      description: "The specific concrete thing that would move this forward.",
    },
    unblock_trigger: {
      type: ["string", "null"],
      description:
        "What external change would make it worth reaching out again. Null if nothing would.",
    },
    last_inbound_at: { type: ["string", "null"] },
    last_outbound_at: { type: ["string", "null"] },
    recommended_action: { type: "string", enum: [...RECOMMENDED_ACTIONS] },
    why_now: {
      type: "string",
      description: "One sentence referencing specific evidence.",
    },
    suppress_until: {
      type: ["string", "null"],
      description: "ISO date before which this lead should not be contacted.",
    },
  },
  required: [
    "lead_temp",
    "blocker",
    "blocker_evidence",
    "blocker_confidence",
    "unblock_path",
    "unblock_trigger",
    "last_inbound_at",
    "last_outbound_at",
    "recommended_action",
    "why_now",
    "suppress_until",
  ],
  additionalProperties: false,
};

const CLASSIFY_SYSTEM = `You classify the state of a mortgage lead from their history, so the broker can see why a lead surfaced and decide whether to trust it.

Two archetypes drive this:

- Newer leads are actively in the market. Speed and availability win. The job is to get them talking and onto a call.
- Older leads are almost always held back by a specific issue — a past denial, credit, equity, income, DTI, timing, or they are shopping another lender. The job is NOT to check in. It is to identify the blocker and either deliver a real reason it may have changed, or stay quiet.

Rules you must follow:

BLOCKER EVIDENCE. If you name a blocker other than "none", blocker_evidence must be a quote copied EXACTLY from the message history you were given — the same characters, not a paraphrase or a summary. Include its date. If you cannot find such a quote, set blocker to "none" and blocker_confidence to "low". An honest "unknown" is more useful than a confident guess, and a guess that cannot be checked is worse than no answer.

DOING NOTHING IS A VALID ANSWER. If the lead is blocked and nothing has changed that would unblock them, recommended_action is "hold". Do not invent a reason to make contact. A manufactured touch on a dead lead is the failure mode this whole system exists to prevent.

CALLS. If recommended_action is "call", that means a human should phone them. Do not draft a message for a call.

WHY_NOW must reference specific evidence — a date, a quote, a field from the loan file. "Following up" is not a reason.

Return only the JSON object.`;

export interface ClassifyInput {
  prospect: BonzoProspect | Record<string, unknown> | null;
  communications: {
    content: string | null;
    direction: string;
    type: string;
    created_at: string;
  }[];
  notes?: { content: string; created_at: string }[];
  leadAgeDays: number;
  /** Today in the broker's timezone, so the model reasons about the right day. */
  todayLocal: string;
}

export interface ClassifyResult {
  state: LeadState;
  usage: ModelUsage;
  /** Set when a claimed quote was not found and the blocker was discarded. */
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

  // Rule 1: no inferred blockers without a verifiable quote.
  if (state.blocker !== "none") {
    const quote = state.blocker_evidence;
    if (!quote || !quoteAppearsInHistory(quote, communications)) {
      evidenceRejected = true;
      state.blocker = "none";
      state.blocker_evidence = null;
      state.blocker_confidence = "low";
      // The unblock path was reasoning from a blocker we just discarded.
      state.unblock_path = null;
      state.unblock_trigger = null;
    }
  }

  // A blocker of "none" cannot carry high confidence in a blocker.
  if (state.blocker === "none" && state.blocker_confidence === "high") {
    state.blocker_confidence = "low";
  }

  // Rule 2: a blocked lead with no fired trigger is held, not messaged.
  if (
    (state.lead_temp === "blocked" || state.lead_temp === "stalled") &&
    !hasFiredTrigger(state)
  ) {
    state.recommended_action = "hold";
  }

  // Rule 3: a suppression date in the future overrides any outreach.
  if (state.suppress_until && isFutureDate(state.suppress_until)) {
    state.recommended_action = "hold";
  }

  return { state, evidenceRejected };
}

/**
 * Whether an unblock trigger has actually fired.
 *
 * Conservative on purpose. The model describes a trigger in prose ("if rates
 * drop below what they were quoted"); nothing in the system observes rate
 * movements yet, so no described trigger counts as fired. When a real signal
 * source exists this is where it plugs in — until then the honest answer is
 * that we cannot know, and the honest behaviour is to hold.
 */
export function hasFiredTrigger(state: LeadState): boolean {
  void state;
  return false;
}

function isFutureDate(iso: string): boolean {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t > Date.now();
}

function buildClassifyMessage(input: ClassifyInput): string {
  const mf = getMortgageFields(input.prospect);
  const parts: string[] = [`Today is ${input.todayLocal}. Lead age: ${input.leadAgeDays} days.`];

  if (mf) {
    const fields = Object.entries(mf)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    if (fields) parts.push(`LOAN FILE:\n${fields}`);
  } else {
    parts.push("LOAN FILE: no mortgage details on record.");
  }

  if (input.communications.length > 0) {
    const sorted = [...input.communications].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    const thread = sorted
      .map((c) => {
        const who = c.direction === "outbound" ? "BROKER" : "PROSPECT";
        return `[${c.created_at.slice(0, 10)}] ${who}: ${c.content?.trim() || "(no content)"}`;
      })
      .join("\n");
    parts.push(
      `MESSAGE HISTORY (oldest to newest). Any quote you use as blocker_evidence must be copied exactly from here:\n${thread}`
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
    withObservedTimestamps(result.parsed, input.communications),
    input.communications
  );

  return { state, usage: result.usage, evidenceRejected };
}

/**
 * Overwrites the inbound/outbound timestamps with what the history actually
 * shows. These are facts we can compute; there is no reason to trust a model
 * to transcribe them, and a wrong one silently distorts the queue's priority.
 */
export function withObservedTimestamps(
  state: LeadState,
  communications: { direction: string; created_at: string }[]
): LeadState {
  const latest = (direction: string): string | null => {
    const times = communications
      .filter((c) => c.direction === direction)
      .map((c) => new Date(c.created_at).getTime())
      .filter((t) => Number.isFinite(t));
    if (times.length === 0) return null;
    return new Date(Math.max(...times)).toISOString();
  };

  return {
    ...state,
    last_inbound_at: latest("inbound"),
    last_outbound_at: latest("outbound"),
  };
}
