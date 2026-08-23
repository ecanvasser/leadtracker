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
  /** Hours after the pitch at which a draft is offered. */
  scheduleHours: number[];
  /** Newest inbound message in the thread, if any. */
  lastInboundAt: string | null;
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
  /** Which scheduled slot this draft is for, in hours since the pitch. */
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

  // ---- Which slot, if any, is owed ----------------------------------------
  const elapsedHours = (input.now.getTime() - pitchedAt.getTime()) / 3_600_000;
  const slots = [...input.scheduleHours].sort((a, b) => a - b);
  const reached = slots.filter((h) => elapsedHours >= h);

  if (reached.length === 0) {
    return { due: false, reason: `only ${elapsedHours.toFixed(1)}h since the quote` };
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
