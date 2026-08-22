import { Contact } from "@/types/db";
import { isInbound, isOutbound } from "@/lib/bonzo/client";
import {
  DEFAULT_TIMEZONE,
  isLocalSaturday,
  isLocalSunday,
  leadAgeDays,
  localDate,
} from "@/lib/time";
import {
  DEFAULT_CADENCE_CONFIG,
  type CadenceConfig,
} from "@/lib/cadence/config";
import type { LeadState, PitchResponse } from "@/lib/insights/lead-state";

/**
 * Phase 7 retirement: the in_market and unresponsive lanes are gone, along
 * with selectLane(). What is left is the lane that holds by default and only
 * speaks when something actually changed — which is the behaviour post-pitch
 * follow-up needs, and the opposite of the scheduled drip the other two lanes
 * existed to drive.
 *
 * The type is a single member rather than being deleted outright because
 * `lane` is still written to daily_queue.lane and read back into the decision
 * trace. What a row means now lives in `inputs.rule`, which was always the
 * more specific field.
 */
export type Lane = "blocked";

/** The only surviving lane. See the note above. */
const LANE: Lane = "blocked";

export interface CadenceContext {
  timeZone: string;
  now: Date;
  config: CadenceConfig;
  /** Null before a lead has ever been classified. */
  leadState: LeadState | null;
}

export function defaultCadenceContext(
  overrides: Partial<CadenceContext> = {}
): CadenceContext {
  return {
    timeZone: DEFAULT_TIMEZONE,
    now: new Date(),
    config: { ...DEFAULT_CADENCE_CONFIG },
    leadState: null,
    ...overrides,
  };
}

export interface OutreachLogEntry {
  id: string;
  contact_id: string;
  action_type: "sms" | "email" | "call";
  status: string;
  created_at: string;
}

export interface BonzoCommEntry {
  id: number;
  content: string | null;
  direction: string;
  type: string;
  created_at: string;
}

export interface QueueAction {
  contactId: string;
  actionType: "sms" | "email" | "call";
  priorityScore: number;
  priorityReason: string;
  touchLabel: string | null;
  lane: Lane;
}

/**
 * The full outcome of planning one lead, including the case where the right
 * answer is to do nothing.
 */
export interface LeadPlan {
  actions: QueueAction[];
  lane: Lane;
  ageDays: number;
  /** True when the engine deliberately chose to stay quiet. */
  hold: boolean;
  /** Why it held, in a sentence, for the decision trace and the UI. */
  holdReason: string | null;
  /** Set when a lead has gone quiet long enough to be worth writing off. */
  recommendAdverse: boolean;
  /** Inputs that drove the decision, recorded verbatim in decision_trace. */
  inputs: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Lane selection
// ---------------------------------------------------------------------------

/**
 * Consecutive outbound messages since the prospect last said anything.
 *
 * Drives the unresponsive lane's hard stop. Calls are excluded — an unanswered
 * call is not the same signal as an ignored message.
 */
export function consecutiveUnanswered(comms: BonzoCommEntry[]): number {
  const sorted = [...comms].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
  let count = 0;
  for (const c of sorted) {
    if (isInbound(c.direction)) break;
    if (isOutbound(c.direction)) count++;
  }
  return count;
}

/** Days since the last outbound touch of any kind, or null if never. */
export function daysSinceLastTouch(
  history: OutreachLogEntry[],
  comms: BonzoCommEntry[],
  ctx: CadenceContext
): number | null {
  const times = [
    ...history.filter((e) => e.status !== "skipped").map((e) => e.created_at),
    ...comms.filter((c) => isOutbound(c.direction)).map((c) => c.created_at),
  ]
    .map((t) => new Date(t).getTime())
    .filter((t) => Number.isFinite(t));

  if (times.length === 0) return null;
  const newest = Math.max(...times);
  const days = Math.floor((ctx.now.getTime() - newest) / 86_400_000);
  return Math.max(0, days);
}

/**
 * Human-readable name for a pitch_response, for hold reasons and card copy.
 *
 * A table rather than a string replace: "soft_no" reads as "soft no", which is
 * not what a broker calls it, and "converted_signal" is not "converted signal".
 */
export function pitchLabel(response: PitchResponse): string {
  const labels: Record<PitchResponse, string> = {
    no_response: "No reply since the quote",
    soft_no: "Soft no",
    price_objection: "Pushed back on price",
    timing_objection: "Pushed back on timing",
    competitor: "Shopping another lender",
    needs_info: "Wants more information",
    positive_intent: "Sounded interested",
    converted_signal: "Reads like a yes",
  };
  return labels[response];
}

function getLastChannelUsed(todayLog: OutreachLogEntry[]): "sms" | "email" | null {
  const msgs = todayLog.filter((e) => e.action_type !== "call");
  if (msgs.length === 0) return null;
  return msgs[msgs.length - 1].action_type as "sms" | "email";
}

function alternateChannel(last: "sms" | "email" | null): "sms" | "email" {
  return last === "sms" ? "email" : "sms";
}

function detectUnansweredReply(
  bonzoComms: BonzoCommEntry[],
  ctx: CadenceContext
): { hasUnanswered: boolean; lastReplyAge: string | null } {
  if (bonzoComms.length === 0) return { hasUnanswered: false, lastReplyAge: null };

  const sorted = [...bonzoComms].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  const lastMsg = sorted[0];
  if (isInbound(lastMsg.direction)) {
    const diffHours = Math.round(
      (ctx.now.getTime() - new Date(lastMsg.created_at).getTime()) / 3_600_000
    );
    const ageStr =
      diffHours < 1 ? "just now" : diffHours === 1 ? "1 hour ago" : `${diffHours} hours ago`;
    return { hasUnanswered: true, lastReplyAge: ageStr };
  }

  return { hasUnanswered: false, lastReplyAge: null };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export function planLead(
  contact: Contact,
  outreachHistory: OutreachLogEntry[],
  bonzoCommunication: BonzoCommEntry[],
  context: Partial<CadenceContext> = {}
): LeadPlan {
  const ctx = defaultCadenceContext(context);
  const ageDays = leadAgeDays(contact.created_at, ctx.timeZone, ctx.now);
  const sinceLastTouch = daysSinceLastTouch(outreachHistory, bonzoCommunication, ctx);
  const unanswered = consecutiveUnanswered(bonzoCommunication);

  const inputs: Record<string, unknown> = {
    age_days: ageDays,
    lane: LANE,
    pitch_response: ctx.leadState?.pitch_response ?? null,
    evidence_confidence: ctx.leadState?.evidence_confidence ?? null,
    days_since_pitch: ctx.leadState?.days_since_pitch ?? null,
    recommended_action: ctx.leadState?.recommended_action ?? null,
    days_since_last_touch: sinceLastTouch,
    consecutive_unanswered: unanswered,
    local_date: localDate(ctx.now, ctx.timeZone),
    timezone: ctx.timeZone,
  };

  const held = (reason: string, extra: Record<string, unknown> = {}): LeadPlan => ({
    actions: [],
    lane: LANE,
    ageDays,
    hold: true,
    holdReason: reason,
    recommendAdverse: false,
    inputs: { ...inputs, ...extra },
  });

  // --- Weekend gates ------------------------------------------------------
  if (!ctx.config.work_sunday && isLocalSunday(ctx.now, ctx.timeZone)) {
    return held("Sunday is switched off in cadence settings", { rule: "sunday_off" });
  }
  if (!ctx.config.work_saturday && isLocalSaturday(ctx.now, ctx.timeZone)) {
    return held("Saturday is switched off in cadence settings", { rule: "saturday_off" });
  }

  // --- Suppression from lead state ---------------------------------------
  if (ctx.leadState?.suppress_until) {
    const until = new Date(ctx.leadState.suppress_until).getTime();
    if (Number.isFinite(until) && until > ctx.now.getTime()) {
      return held(
        `Suppressed until ${ctx.leadState.suppress_until.slice(0, 10)}`,
        { rule: "suppressed" }
      );
    }
  }

  // --- An unanswered inbound outranks every lane -------------------------
  // Someone who just replied is in the market by definition, whatever the
  // last classification said.
  const { hasUnanswered, lastReplyAge } = detectUnansweredReply(bonzoCommunication, ctx);
  if (hasUnanswered) {
    const todayLog = todaysLog(outreachHistory, ctx);
    return {
      actions: [
        {
          contactId: contact.id,
          actionType: alternateChannel(getLastChannelUsed(todayLog)),
          priorityScore: 1000,
          priorityReason: `Unanswered reply from ${lastReplyAge}`,
          touchLabel: null,
          lane: LANE,
        },
      ],
      lane: LANE,
      ageDays,
      hold: false,
      holdReason: null,
      recommendAdverse: false,
      inputs: { ...inputs, rule: "unanswered_inbound" },
    };
  }

  return planBlocked(contact, ctx, { ageDays, sinceLastTouch, inputs });
}

function todaysLog(history: OutreachLogEntry[], ctx: CadenceContext): OutreachLogEntry[] {
  const todayStr = localDate(ctx.now, ctx.timeZone);
  return history.filter((e) => localDate(e.created_at, ctx.timeZone) === todayStr);
}

/**
 * Blocked lane.
 *
 * Fires only when a trigger has actually fired, or a genuinely meaningful
 * interval has elapsed since the blocker was identified. Otherwise it holds.
 * This is the lane that stops "just checking in" messages on dead leads.
 */
function planBlocked(
  contact: Contact,
  ctx: CadenceContext,
  meta: { ageDays: number; sinceLastTouch: number | null; inputs: Record<string, unknown> }
): LeadPlan {
  const { ageDays, sinceLastTouch, inputs } = meta;
  const state = ctx.leadState;

  // The classifier already applied the "no fired trigger means hold" rule.
  // Honouring it here keeps one source of truth for that decision.
  if (state?.recommended_action === "hold") {
    return {
      actions: [],
      lane: "blocked",
      ageDays,
      hold: true,
      holdReason:
        state.pitch_response !== "no_response"
          ? `${pitchLabel(state.pitch_response)} and nothing has changed since`
          : "Classified as hold — no reason to make contact",
      recommendAdverse: false,
      inputs: { ...inputs, rule: "classifier_hold" },
    };
  }

  const interval = ctx.config.blocked_min_days_between_touches;
  if (sinceLastTouch !== null && sinceLastTouch < interval) {
    return {
      actions: [],
      lane: "blocked",
      ageDays,
      hold: true,
      holdReason: `Last touched ${sinceLastTouch} days ago; blocked leads wait ${interval}`,
      recommendAdverse: false,
      inputs: { ...inputs, rule: "blocked_interval_not_elapsed" },
    };
  }

  // A meaningful interval has passed. One touch, and the card names what the
  // classifier read plus the angle to lead with.
  const readLabel = state?.pitch_response
    ? pitchLabel(state.pitch_response)
    : "No classification yet";

  return {
    actions: [
      {
        contactId: contact.id,
        actionType: "email",
        priorityScore: 60,
        priorityReason: `${readLabel} — ${sinceLastTouch ?? "never"} days since last contact`,
        touchLabel: null,
        lane: "blocked",
      },
    ],
    lane: "blocked",
    ageDays,
    hold: false,
    holdReason: null,
    recommendAdverse: false,
    inputs: { ...inputs, rule: "blocked_interval_elapsed" },
  };
}

/** Backwards-compatible wrapper. Prefer planLead, which explains itself. */
export function calculateTodayActions(
  contact: Contact,
  outreachHistory: OutreachLogEntry[],
  bonzoCommunication: BonzoCommEntry[],
  context: Partial<CadenceContext> = {}
): QueueAction[] {
  return planLead(contact, outreachHistory, bonzoCommunication, context).actions;
}
