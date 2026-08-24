/**
 * When a draft is offered during the quoted window (Phase 8 D5).
 *
 * Pure, so the decision can be table-tested without a database. Every guard
 * that stops a draft being generated lives here, in one ordered list, rather
 * than being spread across the job that calls it — a scheduling rule that is
 * enforced in two places is a rule that will eventually be enforced in one.
 *
 * D5's schedule: one draft about three hours after the quote if there has been
 * no reply, one at twenty-four hours if it is still silent, and day two is the
 * handoff decision rather than a third draft. The hours live in
 * `user_settings.draft_schedule_hours`, not here.
 *
 * The clock those hours run against is the **last message**, not the quote.
 * A lead quoted at 9am and messaged again at 2pm has had a touch at 2pm, and
 * a draft three hours after the quote would land on top of it. Eddie sending
 * something resets the clock, which is the behaviour he asked for: if the last
 * message was yesterday a touchpoint is owed, and if it was within a few hours
 * it is not.
 */

import { localDate } from "@/lib/time";
import { isInDraftScope } from "@/lib/ai/draft-one";
import type { AllStages } from "@/types/db";

export interface DraftDueInput {
  stage: AllStages;
  /** When the lead entered Quoted – Follow Up. */
  stageChangedAt: string | null;
  /** The handoff threshold; the far edge of the window. */
  windowDays: number;
  /** Hours after the last message at which a draft is offered. */
  scheduleHours: number[];
  /** Newest inbound message in the thread, if any. */
  lastInboundAt: string | null;
  /**
   * Newest message in either direction, and the schedule's anchor. Eddie's own
   * outbound counts, because a draft's job is to be the next touch and a
   * message he just sent already was one. Null when the thread is empty, in
   * which case the quote anchors instead.
   */
  lastMessageAt: string | null;
  /**
   * Hours of quiet required before anything is due, from
   * `user_settings.min_hours_since_last_message`. A floor under the whole
   * schedule rather than a property of one slot.
   */
  minHoursSinceLastMessage: number;
  /** When drafts have already been generated for this lead, any order. */
  draftsGenerated: string[];
  /** True when a draft for this lead is still waiting to be approved. */
  hasPendingDraft: boolean;
  now: Date;
  timeZone: string;
}

export interface DraftDueResult {
  due: boolean;
  reason: string;
  /** Which scheduled slot this draft is for, in hours since the last message. */
  slotHours?: number;
}

export function draftDue(input: DraftDueInput): DraftDueResult {
  // ---- Scope. Section 7: not before the quote, not after the handoff. ----
  const scope = isInDraftScope({
    stage: input.stage,
    stageChangedAt: input.stageChangedAt,
    windowDays: input.windowDays,
    now: input.now,
  });
  if (!scope.inScope) {
    return { due: false, reason: scope.reason ?? "out of scope" };
  }

  /*
   * D5's second hard constraint: never a draft while an earlier one is still
   * pending approval.
   *
   * Checked before anything else that could produce one, because the failure
   * it prevents is the worst-feeling kind — two cards for the same lead on the
   * phone, and no way to tell which one Send applies to.
   */
  if (input.hasPendingDraft) {
    return { due: false, reason: "an earlier draft is still pending approval" };
  }

  const pitchedAt = new Date(input.stageChangedAt as string);

  /*
   * A reply ends the schedule.
   *
   * The lead is Eddie's move the moment they answer — lib/turn/ says so and
   * the Today screen shows it — and a scheduled draft arriving on top of a
   * live conversation is the uncoordinated second touch this whole phase
   * exists to avoid. He can still ask for a draft by hand from the Today row;
   * what stops here is the automatic one.
   */
  if (input.lastInboundAt) {
    const repliedAt = new Date(input.lastInboundAt).getTime();
    if (Number.isFinite(repliedAt) && repliedAt > pitchedAt.getTime()) {
      return { due: false, reason: "they replied — this one is yours to write" };
    }
  }

  /*
   * D5's first hard constraint: never two drafts to the same lead on the same
   * day. Compared in local calendar days, not as a 24-hour window — "the same
   * day" is what a person means, and the 3-hour and 24-hour slots would
   * otherwise both land on the same afternoon for a lead quoted at 9pm.
   */
  const today = localDate(input.now, input.timeZone);
  const draftedToday = input.draftsGenerated.some(
    (at) => localDate(new Date(at), input.timeZone) === today
  );
  if (draftedToday) {
    return { due: false, reason: "already drafted for this lead today" };
  }

  /*
   * The conversation is still warm — hold off.
   *
   * Checked before the slots rather than folded into them, because it is a
   * different kind of rule: the slots say when a touch is owed, this says
   * when any touch would be intrusive regardless of what is owed. Measured in
   * either direction, so a message Eddie sent five minutes ago suppresses a
   * draft just as a reply would.
   */
  const lastMessage = input.lastMessageAt ? new Date(input.lastMessageAt) : null;
  if (lastMessage && Number.isFinite(lastMessage.getTime())) {
    const quietHours = (input.now.getTime() - lastMessage.getTime()) / 3_600_000;
    if (quietHours < input.minHoursSinceLastMessage) {
      return {
        due: false,
        reason: `last message was ${quietHours.toFixed(1)}h ago`,
      };
    }
  }

  // ---- Which slot, if any, is owed ----------------------------------------
  /*
   * The clock runs from the last message, whether that is before or after the
   * quote. Falling back to the quote only when there are no messages at all.
   *
   * Taking the *later* of the two was wrong in the case that prompted this:
   * a lead whose conversation went quiet three days ago, moved into Quoted –
   * Follow Up this afternoon. The quote is the more recent of the two
   * timestamps, so anchoring on it restarted the clock and reported "only 1h
   * since the last touch" for a thread that had been silent for three days —
   * exactly the lead most owed a touchpoint.
   *
   * Moving a card is not a touch. Only a message is, so only a message
   * anchors the schedule.
   */
  const anchor =
    lastMessage && Number.isFinite(lastMessage.getTime()) ? lastMessage : pitchedAt;
  const elapsedHours = (input.now.getTime() - anchor.getTime()) / 3_600_000;
  const slots = [...input.scheduleHours].sort((a, b) => a - b);
  const reached = slots.filter((h) => elapsedHours >= h);

  if (reached.length === 0) {
    return { due: false, reason: `only ${elapsedHours.toFixed(1)}h since the last touch` };
  }

  /*
   * Slots are consumed in order rather than matched to the clock. A lead
   * quoted on Friday evening whose first sweep is Monday has passed both
   * slots, and the right behaviour is one draft now and the second tomorrow —
   * not two at once, and not silently skipping the first.
   */
  if (input.draftsGenerated.length >= reached.length) {
    return { due: false, reason: "every slot reached so far has been drafted" };
  }

  return {
    due: true,
    reason: `slot at ${reached[input.draftsGenerated.length]}h`,
    slotHours: reached[input.draftsGenerated.length],
  };
}
