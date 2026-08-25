/**
 * When an agent's next touch may fire.
 *
 * Pure, and separate from the job that acts on it, for the same reason
 * lib/turn is: these are the rules that decide whether a message gets written
 * to a real person, and they should be readable and testable without a
 * database or a model behind them.
 *
 * The guards are deliberately the same shape as the quoted-window scheduler's.
 * An agent is not a licence to ignore them — it changes what a touch is about,
 * not whether it is welcome.
 */

import { localDate } from "@/lib/time";
import type { AgentPlan, AgentStatus, TouchStatus } from "@/lib/agents/types";

export interface TouchDueInput {
  agentStatus: AgentStatus;
  touchStatus: TouchStatus;
  dueAt: string;
  /** When the agent was activated; the reply check is measured from here. */
  activatedAt: string | null;
  /** Newest message in either direction, audit entries excluded. */
  lastMessageAt: string | null;
  /** Newest inbound message. */
  lastInboundAt: string | null;
  /** Hours of quiet required before any draft. Shared with draft-schedule. */
  minHoursSinceLastMessage: number;
  /** A card for this contact is already waiting on a decision. */
  hasPendingCard: boolean;
  /** Timestamps of agent drafts already generated for this contact. */
  draftsGenerated: string[];
  now: Date;
  timeZone: string;
}

export interface TouchDueResult {
  due: boolean;
  reason: string;
}

export function touchDue(input: TouchDueInput): TouchDueResult {
  if (input.agentStatus !== "active") {
    return { due: false, reason: `agent is ${input.agentStatus}` };
  }
  if (input.touchStatus !== "pending") {
    return { due: false, reason: `touch is ${input.touchStatus}` };
  }

  const dueAt = new Date(input.dueAt).getTime();
  if (!Number.isFinite(dueAt)) {
    return { due: false, reason: "touch has an unreadable due time" };
  }
  if (input.now.getTime() < dueAt) {
    const hours = (dueAt - input.now.getTime()) / 3_600_000;
    return { due: false, reason: `not due for ${hours.toFixed(1)}h` };
  }

  /*
   * Never two cards for the same lead at once. Two drafts on the phone with
   * no way to tell which Send applies to is the worst-feeling failure this
   * system can produce, and it is the same rule draft-schedule enforces.
   */
  if (input.hasPendingCard) {
    return { due: false, reason: "an earlier card is still waiting" };
  }

  /*
   * A reply since activation stops the sequence.
   *
   * The agent is paused for this properly elsewhere, on the refresh path, so
   * that Eddie gets told. This is the backstop for the window between a reply
   * landing in Bonzo and the refresh noticing it: without it, a touch could go
   * out on top of a conversation that started four minutes ago.
   */
  if (input.lastInboundAt && input.activatedAt) {
    const replied = new Date(input.lastInboundAt).getTime();
    const activated = new Date(input.activatedAt).getTime();
    if (Number.isFinite(replied) && replied > activated) {
      return { due: false, reason: "they replied — the agent should be paused" };
    }
  }

  // The hold-off floor. Eddie's own messages count: a touch three hours after
  // he texted the lead himself is the app talking over him.
  if (input.lastMessageAt) {
    const since = (input.now.getTime() - new Date(input.lastMessageAt).getTime()) / 3_600_000;
    if (Number.isFinite(since) && since < input.minHoursSinceLastMessage) {
      return { due: false, reason: `last message was ${since.toFixed(1)}h ago` };
    }
  }

  // One agent draft per lead per local day, whatever the plan says.
  const today = localDate(input.now, input.timeZone);
  const draftedToday = input.draftsGenerated.some(
    (at) => localDate(new Date(at), input.timeZone) === today
  );
  if (draftedToday) {
    return { due: false, reason: "already drafted for this lead today" };
  }

  return { due: true, reason: "due" };
}

/**
 * Turns an activated plan into scheduled touch rows.
 *
 * Days are counted from activation rather than from deployment, so a plan
 * built in the morning and activated that evening still gets its full spacing.
 */
export function scheduleTouches(
  plan: AgentPlan,
  activatedAt: Date
): { step_index: number; due_at: string }[] {
  return plan.steps.map((s) => ({
    step_index: s.step,
    due_at: new Date(activatedAt.getTime() + s.day * 86_400_000).toISOString(),
  }));
}
