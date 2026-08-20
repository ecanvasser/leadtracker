import { Contact } from "@/types/db";
import {
  DEFAULT_TIMEZONE,
  addLocalDays,
  isLocalSaturday,
  isLocalSunday,
  leadAgeDays,
  localDate,
} from "@/lib/time";
import {
  DEFAULT_CADENCE_CONFIG,
  type CadenceConfig,
} from "@/lib/cadence/config";
import type { LeadState } from "@/lib/insights/lead-state";

/**
 * Lane selection is explicit and testable.
 *
 * The old engine treated every lead identically, which is why the output was
 * unusable: a lead blocked on a credit event got the same "scheduled touch"
 * treatment as one that opted in this morning.
 *
 * - in_market  — actively shopping. Speed and availability win. Get them
 *                talking and onto a call.
 * - blocked    — held back by a specific, identified issue. The job is not to
 *                check in. Either deliver a real reason the blocker may have
 *                changed, or stay quiet.
 * - unresponsive — they are not answering. Very low frequency, channel
 *                rotation, and a hard stop rather than an indefinite drip.
 */
export type Lane = "in_market" | "blocked" | "unresponsive";

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
  /** Set when a lead has exhausted the unresponsive lane. */
  recommendAdverse: boolean;
  /** Inputs that drove the decision, recorded verbatim in decision_trace. */
  inputs: Record<string, unknown>;
}

interface CadenceTarget {
  messagesTouches: number;
  calls: number;
  channelHint: ("sms" | "email")[];
}

// ---------------------------------------------------------------------------
// Lane selection
// ---------------------------------------------------------------------------

/**
 * Chooses a lane from the classified lead state, falling back to age.
 *
 * Before a lead has been classified there is no evidence of a blocker, so a
 * young lead is treated as in-market and an old one as blocked. That mirrors
 * the two archetypes: new leads are shopping, old ones are stuck on something.
 */
export function selectLane(
  leadState: LeadState | null,
  ageDays: number,
  config: CadenceConfig
): Lane {
  if (leadState) {
    switch (leadState.lead_temp) {
      case "in_market":
      case "warming":
        return "in_market";
      case "stalled":
      case "blocked":
        return "blocked";
      case "unresponsive":
        return "unresponsive";
    }
  }
  return ageDays <= config.in_market_max_age_days ? "in_market" : "blocked";
}

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
    if (c.direction === "inbound") break;
    if (c.direction === "outbound") count++;
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
    ...comms.filter((c) => c.direction === "outbound").map((c) => c.created_at),
  ]
    .map((t) => new Date(t).getTime())
    .filter((t) => Number.isFinite(t));

  if (times.length === 0) return null;
  const newest = Math.max(...times);
  const days = Math.floor((ctx.now.getTime() - newest) / 86_400_000);
  return Math.max(0, days);
}

// ---------------------------------------------------------------------------
// In-market cadence (unchanged rhythm — it was roughly right)
// ---------------------------------------------------------------------------

function getCadenceTarget(ageDays: number): CadenceTarget {
  if (ageDays === 0) {
    return { messagesTouches: 3, calls: 2, channelHint: ["sms", "email", "sms"] };
  }
  if (ageDays <= 3) {
    return { messagesTouches: 2, calls: 1, channelHint: ["sms", "email"] };
  }
  if (ageDays <= 7) {
    return { messagesTouches: 1, calls: 1, channelHint: ["sms"] };
  }
  if (ageDays <= 14) {
    return { messagesTouches: 1, calls: 0.5, channelHint: ["email"] };
  }
  if (ageDays <= 21) {
    return { messagesTouches: 0.5, calls: 0.3, channelHint: ["sms"] };
  }
  if (ageDays <= 30) {
    return { messagesTouches: 0.4, calls: 0.15, channelHint: ["email"] };
  }
  return { messagesTouches: 0.15, calls: 0.07, channelHint: ["email"] };
}

function shouldActToday(frequency: number, ageDays: number): number {
  if (frequency >= 1) return Math.round(frequency);
  const period = Math.round(1 / frequency);
  return ageDays % period === 0 ? 1 : 0;
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
  if (lastMsg.direction === "inbound") {
    const diffHours = Math.round(
      (ctx.now.getTime() - new Date(lastMsg.created_at).getTime()) / 3_600_000
    );
    const ageStr =
      diffHours < 1 ? "just now" : diffHours === 1 ? "1 hour ago" : `${diffHours} hours ago`;
    return { hasUnanswered: true, lastReplyAge: ageStr };
  }

  return { hasUnanswered: false, lastReplyAge: null };
}

function checkOverdue(
  ageDays: number,
  recentLog: OutreachLogEntry[],
  ctx: CadenceContext
): boolean {
  if (ageDays === 0) return false;

  const yesterdayStr = addLocalDays(localDate(ctx.now, ctx.timeZone), -1);
  const yesterdayActions = recentLog.filter(
    (e) => localDate(e.created_at, ctx.timeZone) === yesterdayStr && e.status !== "skipped"
  );

  const target = getCadenceTarget(ageDays - 1);
  const expectedTouches = shouldActToday(target.messagesTouches, ageDays - 1);
  return yesterdayActions.length < expectedTouches && expectedTouches > 0;
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
  const lane = selectLane(ctx.leadState, ageDays, ctx.config);
  const sinceLastTouch = daysSinceLastTouch(outreachHistory, bonzoCommunication, ctx);
  const unanswered = consecutiveUnanswered(bonzoCommunication);

  const inputs: Record<string, unknown> = {
    age_days: ageDays,
    lane,
    lead_temp: ctx.leadState?.lead_temp ?? null,
    blocker: ctx.leadState?.blocker ?? null,
    blocker_confidence: ctx.leadState?.blocker_confidence ?? null,
    recommended_action: ctx.leadState?.recommended_action ?? null,
    days_since_last_touch: sinceLastTouch,
    consecutive_unanswered: unanswered,
    local_date: localDate(ctx.now, ctx.timeZone),
    timezone: ctx.timeZone,
  };

  const held = (reason: string, extra: Record<string, unknown> = {}): LeadPlan => ({
    actions: [],
    lane,
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
  const saturday = isLocalSaturday(ctx.now, ctx.timeZone);
  if (!ctx.config.work_saturday && saturday) {
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
          lane: "in_market",
        },
      ],
      lane: "in_market",
      ageDays,
      hold: false,
      holdReason: null,
      recommendAdverse: false,
      inputs: { ...inputs, rule: "unanswered_inbound", lane: "in_market" },
    };
  }

  switch (lane) {
    case "unresponsive":
      return planUnresponsive(contact, outreachHistory, ctx, {
        ageDays,
        unanswered,
        sinceLastTouch,
        inputs,
      });
    case "blocked":
      return planBlocked(contact, ctx, { ageDays, sinceLastTouch, inputs });
    case "in_market":
    default:
      return planInMarket(contact, outreachHistory, ctx, { ageDays, saturday, inputs });
  }
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
        state.blocker !== "none"
          ? `Blocked on ${state.blocker.replace(/_/g, " ")} and nothing has changed`
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

  // A meaningful interval has passed. One touch, and it must speak to the
  // blocker — the drafting prompt receives the blocker and its evidence.
  const blockerLabel = state?.blocker && state.blocker !== "none"
    ? state.blocker.replace(/_/g, " ")
    : "unknown blocker";

  return {
    actions: [
      {
        contactId: contact.id,
        actionType: "email",
        priorityScore: 60,
        priorityReason: `Blocked on ${blockerLabel} — ${sinceLastTouch ?? "never"} days since last contact`,
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

/**
 * Unresponsive lane.
 *
 * Very low frequency with channel rotation, and a hard stop: past the
 * configured number of consecutive unanswered messages the lead is surfaced
 * as a candidate for Adverse rather than dripped at forever.
 */
function planUnresponsive(
  contact: Contact,
  history: OutreachLogEntry[],
  ctx: CadenceContext,
  meta: {
    ageDays: number;
    unanswered: number;
    sinceLastTouch: number | null;
    inputs: Record<string, unknown>;
  }
): LeadPlan {
  const { ageDays, unanswered, sinceLastTouch, inputs } = meta;

  if (unanswered >= ctx.config.unresponsive_max_consecutive) {
    return {
      actions: [],
      lane: "unresponsive",
      ageDays,
      hold: true,
      holdReason: `${unanswered} messages with no reply — recommend moving to Adverse`,
      recommendAdverse: true,
      inputs: { ...inputs, rule: "unresponsive_hard_stop" },
    };
  }

  // Wider spacing than the blocked lane: they are not refusing, they are not
  // reading.
  const interval = ctx.config.blocked_min_days_between_touches;
  if (sinceLastTouch !== null && sinceLastTouch < interval) {
    return {
      actions: [],
      lane: "unresponsive",
      ageDays,
      hold: true,
      holdReason: `Last touched ${sinceLastTouch} days ago; waiting ${interval}`,
      recommendAdverse: false,
      inputs: { ...inputs, rule: "unresponsive_interval_not_elapsed" },
    };
  }

  // Rotate channel on every attempt — the previous one demonstrably failed.
  const lastChannel = getLastChannelUsed(history);
  return {
    actions: [
      {
        contactId: contact.id,
        actionType: alternateChannel(lastChannel),
        priorityScore: 30,
        priorityReason: `No reply to last ${unanswered} — trying ${alternateChannel(lastChannel)}`,
        touchLabel: `Attempt ${unanswered + 1} of ${ctx.config.unresponsive_max_consecutive}`,
        lane: "unresponsive",
      },
    ],
    lane: "unresponsive",
    ageDays,
    hold: false,
    holdReason: null,
    recommendAdverse: false,
    inputs: { ...inputs, rule: "unresponsive_rotate" },
  };
}

/** In-market lane — the existing aggressive rhythm, which was roughly right. */
function planInMarket(
  contact: Contact,
  outreachHistory: OutreachLogEntry[],
  ctx: CadenceContext,
  meta: { ageDays: number; saturday: boolean; inputs: Record<string, unknown> }
): LeadPlan {
  const { ageDays, saturday, inputs } = meta;
  const cadence = getCadenceTarget(ageDays);
  const todayLog = todaysLog(outreachHistory, ctx);

  const todayMessages = todayLog.filter(
    (e) => e.action_type !== "call" && e.status !== "skipped"
  );
  const todayCalls = todayLog.filter(
    (e) => e.action_type === "call" && e.status !== "skipped"
  );

  let targetMessages = shouldActToday(cadence.messagesTouches, ageDays);
  let targetCalls = shouldActToday(cadence.calls, ageDays);

  if (saturday) {
    targetMessages = Math.min(targetMessages, ctx.config.saturday_max_messages);
    targetCalls = ctx.config.saturday_calls ? targetCalls : 0;
  }

  const remainingMessages = Math.max(0, targetMessages - todayMessages.length);
  const remainingCalls = Math.max(0, targetCalls - todayCalls.length);
  const isOverdue = checkOverdue(ageDays, outreachHistory, ctx);

  let baseScore = 100;
  if (ageDays === 0) baseScore = 500;
  else if (ageDays <= 3) baseScore = 300;
  else if (ageDays <= 7) baseScore = 200;
  else if (ageDays <= 14) baseScore = 100;
  else baseScore = 50;
  if (isOverdue) baseScore += 400;

  const actions: QueueAction[] = [];
  const lastChannel = getLastChannelUsed(todayLog);
  const totalTouches = remainingMessages + remainingCalls;

  for (let i = 0; i < remainingMessages; i++) {
    const hinted = cadence.channelHint[todayMessages.length + i];
    const channel: "sms" | "email" =
      hinted ??
      alternateChannel(
        i === 0
          ? lastChannel
          : actions[actions.length - 1]?.actionType === "sms"
            ? "sms"
            : "email"
      );

    const reason = isOverdue
      ? "Overdue — missed yesterday's cadence"
      : ageDays === 0
        ? "Day 1 — speed to lead"
        : ageDays <= 3
          ? `Day ${ageDays + 1} — early cadence`
          : "Scheduled touch";

    const touchNum = todayMessages.length + i + 1;
    actions.push({
      contactId: contact.id,
      actionType: channel,
      priorityScore: baseScore - i,
      priorityReason: reason,
      touchLabel:
        totalTouches > 1 ? `Touch ${touchNum} of ${targetMessages + targetCalls}` : null,
      lane: "in_market",
    });
  }

  for (let i = 0; i < remainingCalls; i++) {
    const reason =
      ageDays === 0
        ? "Day 1 — intro call"
        : ageDays <= 3
          ? `Day ${ageDays + 1} — follow-up call`
          : "Scheduled call";

    const touchNum =
      todayMessages.length + remainingMessages + todayCalls.length + i + 1;
    actions.push({
      contactId: contact.id,
      actionType: "call",
      priorityScore: baseScore + 25 - i,
      priorityReason: reason,
      touchLabel:
        totalTouches > 1 ? `Touch ${touchNum} of ${targetMessages + targetCalls}` : null,
      lane: "in_market",
    });
  }

  return {
    actions,
    lane: "in_market",
    ageDays,
    hold: actions.length === 0,
    holdReason: actions.length === 0 ? "No touch due today under the in-market cadence" : null,
    recommendAdverse: false,
    inputs: {
      ...inputs,
      rule: isOverdue ? "in_market_overdue" : "in_market_scheduled",
      target_messages: targetMessages,
      target_calls: targetCalls,
      base_score: baseScore,
      is_overdue: isOverdue,
    },
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
