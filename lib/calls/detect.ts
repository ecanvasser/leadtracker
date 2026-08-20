/**
 * Detecting a call commitment in a message.
 *
 * Cost rule C5: try a cheap deterministic pass first and only fall through to
 * the model when the text is genuinely ambiguous. Most call commitments are
 * formulaic ("call me tomorrow at 2", "let's talk Thursday at 10") and a regex
 * handles them for nothing.
 *
 * Everything detected lands as `proposed`. Nothing here confirms a call — a
 * misparsed time is worse than no reminder, so a human always says yes first.
 */

import { callModel, type ModelUsage } from "@/lib/ai/models";
import { instantForLocalTime } from "@/lib/calls/timezone";
import { addLocalDays, localDate, localDayOfWeek } from "@/lib/time";

export interface CallCandidate {
  /** Local wall-clock date in the prospect's zone, YYYY-MM-DD. */
  date: string;
  hour: number;
  minute: number;
  /** The exact words the time was read out of. */
  quote: string;
  /** How the time was determined. */
  method: "pattern" | "model";
  /** Set when the text names a day but no time, or a time but no day. */
  incomplete?: boolean;
}

export interface DetectionResult {
  candidate: CallCandidate | null;
  usage?: ModelUsage;
  /** True when the pattern pass was enough and no model call was made. */
  resolvedLocally: boolean;
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
};

/**
 * Phrases that signal an actual commitment rather than idle mention of a day.
 *
 * "I'm free Thursday" is a commitment; "I got denied on Thursday" is not. The
 * gate is deliberately narrow — a false positive costs the broker a pointless
 * confirmation prompt, and enough of those and he stops reading them.
 */
const COMMITMENT_PATTERNS = [
  /\bcall me\b/i,
  /\bgive me a call\b/i,
  /\bcan you call\b/i,
  /\blet'?s (?:talk|chat|connect|hop on|jump on)\b/i,
  /\btalk (?:then|to you)\b/i,
  /\bi'?m (?:free|available|around|open)\b/i,
  /\bworks for me\b/i,
  /\bschedule (?:a|the) call\b/i,
  /\bset (?:up|something up)\b/i,
  /\bavailable\b/i,
  /\breach me\b/i,
];

export function looksLikeCommitment(text: string): boolean {
  return COMMITMENT_PATTERNS.some((p) => p.test(text));
}

/** "2", "2pm", "2:30", "14:00", "2 o'clock" -> {hour, minute} in 24h. */
export function parseTimeOfDay(
  text: string
): { hour: number; minute: number; explicitMeridiem: boolean } | null {
  const m = text.match(
    /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?:\s*o'?clock)?\b/i
  );
  if (!m) return null;

  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3]?.toLowerCase().replace(/\./g, "");

  if (hour > 23 || minute > 59) return null;

  if (meridiem === "pm" && hour < 12) hour += 12;
  else if (meridiem === "am" && hour === 12) hour = 0;
  else if (!meridiem) {
    // No meridiem given. A bare 1-6 in a business conversation means the
    // afternoon; 7-11 means the morning. This is a guess, which is exactly
    // why nothing auto-confirms.
    if (hour >= 1 && hour <= 6) hour += 12;
  }

  return { hour, minute, explicitMeridiem: Boolean(meridiem) };
}

/**
 * Resolves a spoken day reference to a concrete local date.
 *
 * Always forward-looking: "Thursday" said on a Thursday means next Thursday,
 * not today, unless a time later today is explicitly given.
 */
export function resolveDayReference(
  text: string,
  todayLocal: string,
  timeZone: string
): string | null {
  const lower = text.toLowerCase();

  if (/\btoday\b/.test(lower)) return todayLocal;
  if (/\btomorrow\b/.test(lower)) return addLocalDays(todayLocal, 1);

  const dayMatch = lower.match(
    /\b(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/
  );
  if (!dayMatch) return null;

  const target = WEEKDAYS[dayMatch[1]];
  if (target === undefined) return null;

  const todayDow = localDayOfWeek(new Date(`${todayLocal}T12:00:00Z`), timeZone);
  let delta = (target - todayDow + 7) % 7;

  // "next Thursday" means the following week, and a same-day reference rolls
  // forward rather than pointing at an hour that has already passed.
  if (delta === 0) delta = 7;
  if (/\bnext\s+\w+day\b/.test(lower) && delta < 7) delta += 7;

  return addLocalDays(todayLocal, delta);
}

/**
 * The cheap pass.
 *
 * Returns null when the text is ambiguous, which is the signal to escalate.
 */
export function detectByPattern(
  text: string,
  todayLocal: string,
  timeZone: string
): CallCandidate | null {
  if (!looksLikeCommitment(text)) return null;

  const date = resolveDayReference(text, todayLocal, timeZone);
  const time = parseTimeOfDay(text);

  // A day with no time, or a time with no day, is not enough to schedule on.
  if (!date || !time) return null;

  // An hour with no am/pm inside a range ("between 2 and 4") is too loose to
  // pin down; let the model read the whole sentence.
  if (!time.explicitMeridiem && /\bbetween\b|\bor\b|-\s*\d/.test(text)) return null;

  return {
    date,
    hour: time.hour,
    minute: time.minute,
    quote: text.trim().slice(0, 300),
    method: "pattern",
  };
}

const EXTRACT_SYSTEM = `You read one message between a mortgage broker and a client and decide whether it commits to a phone call at a specific time.

Return a JSON object:
- "is_commitment": true only if the message agrees to or proposes a call at a identifiable time. Mentioning a day in passing is not a commitment.
- "date": the date of the call as YYYY-MM-DD, or null.
- "hour": 0-23 local to the person who wrote it, or null.
- "minute": 0-59, or null.
- "quote": the exact words from the message that state the time, copied character for character.

If the message is vague ("sometime next week", "I'll call you back"), is_commitment is false. A missed call is worse than no reminder, so when in doubt say false.`;

const EXTRACT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    is_commitment: { type: "boolean" },
    date: { type: ["string", "null"] },
    hour: { type: ["integer", "null"] },
    minute: { type: ["integer", "null"] },
    quote: { type: ["string", "null"] },
  },
  required: ["is_commitment", "date", "hour", "minute", "quote"],
  additionalProperties: false,
};

/**
 * Detects a call commitment, escalating to the model only when needed.
 *
 * The model used is ANTHROPIC_MODEL_EXTRACT (Haiku by default) — this is
 * extraction, not judgment.
 */
export async function detectCallCommitment(
  text: string,
  todayLocal: string,
  timeZone: string
): Promise<DetectionResult> {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { candidate: null, resolvedLocally: true };

  // Nothing that reads like a commitment: stop here, no model, no cost. This
  // is the branch that keeps detection nearly free across a whole history.
  if (!looksLikeCommitment(trimmed)) {
    return { candidate: null, resolvedLocally: true };
  }

  const byPattern = detectByPattern(trimmed, todayLocal, timeZone);
  if (byPattern) return { candidate: byPattern, resolvedLocally: true };

  // Reads like a commitment but the shape is ambiguous — worth one cheap call.
  const result = await callModel<{
    is_commitment: boolean;
    date: string | null;
    hour: number | null;
    minute: number | null;
    quote: string | null;
  }>({
    role: "extract",
    system: EXTRACT_SYSTEM,
    schema: EXTRACT_SCHEMA,
    maxTokens: 512,
    messages: [
      {
        role: "user",
        content: `Today is ${todayLocal}.\n\nMESSAGE:\n${trimmed}`,
      },
    ],
  });

  const parsed = result.parsed;
  if (
    !parsed?.is_commitment ||
    !parsed.date ||
    parsed.hour === null ||
    parsed.hour === undefined
  ) {
    return { candidate: null, usage: result.usage, resolvedLocally: false };
  }

  return {
    candidate: {
      date: parsed.date,
      hour: parsed.hour,
      minute: parsed.minute ?? 0,
      quote: (parsed.quote ?? trimmed).slice(0, 300),
      method: "model",
    },
    usage: result.usage,
    resolvedLocally: false,
  };
}

/** Turns a candidate into the instant to store. */
export function candidateToInstant(
  candidate: CallCandidate,
  timeZone: string
): Date {
  return instantForLocalTime(
    candidate.date,
    candidate.hour,
    candidate.minute,
    timeZone
  );
}

/** Today in a zone, for callers that only have an instant. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return localDate(now, timeZone);
}
