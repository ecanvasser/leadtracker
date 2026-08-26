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
import { isOutbound } from "@/lib/bonzo/client";
import { instantForLocalTime } from "@/lib/calls/timezone";
import { localDate } from "@/lib/time";

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

/*
 * The per-message pattern detector that used to live here is gone.
 *
 * It asked "does this sentence commit to a call?", which cannot see the shape
 * a booking actually takes in these threads:
 *
 *   BROKER: When is a good time to call?
 *   LEAD:   5pm
 *
 * Neither message commits to anything alone. Widening the phrase list to catch
 * the reply made it fire on "I get paid on the 15th"; narrowing it to exclude
 * that put the reply back out of reach. The gate was the wrong instrument, not
 * a badly tuned one, so it was removed rather than tuned again.
 *
 * detectCallInThread below reads the whole exchange in one cheap call instead.
 */

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

// ---------------------------------------------------------------------------
// Thread-level detection
//
// The per-message detector above asks "does this sentence contain a call
// commitment?" and that is the wrong question for a conversation. The commonest
// way a call gets booked here is:
//
//   BROKER: When is a good time to call so we can look at some quotes together?
//   LEAD:   5pm
//
// No single message contains a commitment. The intent is in the question and
// the time is in the answer, and any amount of pattern-matching on one message
// at a time will keep missing it. Gerald Leono's 5pm was lost exactly this way.
//
// So the thread goes to the model whole. It runs on the `extract` role — Haiku
// — and only when new messages have actually arrived, so the cost rule that
// polling never spends still holds.
// ---------------------------------------------------------------------------

export interface ThreadMessage {
  direction: string;
  content: string | null;
  created_at: string;
}

export interface ThreadDetection {
  /** A specific time both sides landed on. */
  call: {
    date: string;
    hour: number;
    minute: number;
    quote: string;
  } | null;
  /** They asked to talk but no time was ever settled. */
  wantsCall: { quote: string } | null;
  usage?: ModelUsage;
}

const THREAD_SYSTEM = `You read a conversation between a mortgage broker and a lead, and answer one question: is there a phone call to put in the diary?

You are given the messages in order, each labelled BROKER or LEAD, with the local date and time it was sent.

RETURN A SCHEDULED CALL when the two of them landed on a specific time.

The commitment is often split across two messages. "When is a good time to call?" followed by "5pm" is a scheduled call at 5pm — the intent is in the question and the time is in the answer. So is "Can you do Thursday?" / "Yes". Read the exchange, not the sentence.

The time is in the LEAD's local timezone. Resolve relative words against the date of the message that used them: "tomorrow" in a message sent on the 3rd means the 4th. If only a time is given with no day, it means the day that message was sent — unless that time had already passed when it was sent, in which case it means the next day.

If they renegotiated, only the last agreement counts.

RETURN WANTS_CALL when the LEAD asked to talk, or agreed to talk, but no specific time was ever settled. "Let's talk in the morning", "call me when you get a chance", "what time are you available?" — a real request with nothing to put in a diary. Only when the LEAD wants it: the broker asking to talk is not the lead asking.

RETURN NEITHER when there is no call in the conversation. This is the common case and the honest answer. Do not manufacture one.

NEVER treat these as a call time:
- Dates about anything else — "I get paid on the 15th", "closing is in June", "I was denied on Thursday"
- The broker stating his own availability — "I'm around after 11" — unless the lead then agreed to a specific time
- A call that already happened

QUOTE must be copied exactly from the message it came from. For a split commitment, quote the LEAD's reply that named the time.`;

const THREAD_SCHEMA = {
  type: "object",
  properties: {
    has_call: { type: "boolean" },
    date: {
      type: ["string", "null"],
      description: "YYYY-MM-DD in the lead's local timezone. Null when has_call is false.",
    },
    hour: { type: ["integer", "null"], description: "0-23 local. Null when has_call is false." },
    minute: { type: ["integer", "null"] },
    call_quote: {
      type: ["string", "null"],
      description: "The exact words the time came from.",
    },
    wants_call: {
      type: "boolean",
      description: "The lead asked to talk but no time was settled. False when has_call is true.",
    },
    wants_call_quote: { type: ["string", "null"] },
  },
  required: [
    "has_call",
    "date",
    "hour",
    "minute",
    "call_quote",
    "wants_call",
    "wants_call_quote",
  ],
  additionalProperties: false,
};

/** How many messages of history the model reads. */
const THREAD_WINDOW = 40;

export async function detectCallInThread(
  messages: ThreadMessage[],
  todayLocal: string,
  timeZone: string
): Promise<ThreadDetection> {
  const usable = messages.filter((m) => (m.content ?? "").trim());
  if (usable.length === 0) return { call: null, wantsCall: null };

  const transcript = usable
    .slice(-THREAD_WINDOW)
    .map((m) => {
      const stamp = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(m.created_at));
      const who = isOutbound(m.direction) ? "BROKER" : "LEAD";
      return `[${stamp}] ${who}: ${(m.content ?? "").trim()}`;
    })
    .join("\n");

  const result = await callModel<{
    has_call: boolean;
    date: string | null;
    hour: number | null;
    minute: number | null;
    call_quote: string | null;
    wants_call: boolean;
    wants_call_quote: string | null;
  }>({
    role: "extract",
    system: THREAD_SYSTEM,
    schema: THREAD_SCHEMA,
    maxTokens: 1024,
    messages: [
      {
        role: "user",
        content: `Today is ${todayLocal}. The lead's timezone is ${timeZone}.\n\nCONVERSATION:\n${transcript}`,
      },
    ],
  });

  const p = result.parsed;
  if (!p) return { call: null, wantsCall: null, usage: result.usage };

  if (p.has_call && p.date && p.hour !== null && p.hour !== undefined) {
    return {
      call: {
        date: p.date,
        hour: p.hour,
        minute: p.minute ?? 0,
        quote: (p.call_quote ?? "").trim(),
      },
      wantsCall: null,
      usage: result.usage,
    };
  }

  if (p.wants_call && (p.wants_call_quote ?? "").trim()) {
    return {
      call: null,
      wantsCall: { quote: (p.wants_call_quote as string).trim() },
      usage: result.usage,
    };
  }

  return { call: null, wantsCall: null, usage: result.usage };
}
