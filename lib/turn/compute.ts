/**
 * computeTurn — the one function that decides whose move a lead is.
 *
 * Pure. No database calls, no `new Date()` reached for internally, no I/O of
 * any kind: every fact it needs arrives in {@link TurnInput}. That is what
 * lets the web page and the Telegram bot share it, and section 5.1 is
 * explicit that if those two can ever disagree, it is a bug.
 *
 * ## The precedence ladder
 *
 * Order matters more than any individual rule here, so it is written out
 * once, in one place, and every branch below is numbered against it:
 *
 *   1. Terminal stage        -> waiting  (defensive; callers filter first)
 *   2. Confirmed call booked -> waiting
 *   3. Snoozed               -> waiting
 *   4. Task due or overdue   -> yours
 *   5. Stage is needs_quote  -> yours
 *   6. Last message inbound  -> yours
 *   7. Handed off to nurture -> waiting
 *   8. Last message outbound -> theirs (or waiting, if not yet overdue)
 *   9. Nothing known         -> waiting
 *
 * Two orderings in that list are judgement calls rather than transcriptions
 * of the spec, and both are deliberate:
 *
 * **6 before 7** — a lead who replied *after* being handed to a campaign is
 * Eddie's move again. The handoff does not outrank a human answering.
 *
 * **6 before the classifier's `hold`** — an unanswered inbound message beats a
 * model's opinion that nothing needs doing. The failure modes are asymmetric
 * in exactly the way D4 describes: `hold` winning means a real question sits
 * unread, while inbound winning means one extra row in Your move. So `hold`
 * only ever applies when the last message is outbound, where it is choosing
 * between two flavours of Waiting and can do no damage.
 */

import { isFuture } from "@/lib/turn/guards";
import {
  describeHoursAgo,
  describeWait,
  formatCallWhen,
  formatShortDate,
  formatShortDay,
  localDaysSince,
} from "@/lib/turn/format";
import type { TurnInput, TurnResult, TurnVerdict } from "@/lib/turn/types";
import { localDate, startOfLocalDayUtc } from "@/lib/time";
import { STAGE_LABELS, TERMINAL_STAGES, type AllStages } from "@/types/db";

/**
 * Stages the Today screen counts. Adverse and Funded are terminal and live on
 * their own pages — a dead deal in the Waiting list is noise, not
 * reassurance. Exported so the web page and the bot filter identically; the
 * test that the three counts sum to the active total depends on both using
 * this and nothing else.
 */
export function isTodayActive(stage: AllStages): boolean {
  return !(TERMINAL_STAGES as readonly string[]).includes(stage);
}

function toTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/** The later of two instants, either of which may be unknown. */
function latest(a: string | null, b: string | null): string | null {
  const ta = toTime(a);
  const tb = toTime(b);
  if (ta === null) return tb === null ? null : b;
  if (tb === null) return a;
  return ta >= tb ? a : b;
}

/** The earlier of two instants, either of which may be unknown. */
function earliest(a: string | null, b: string | null): string | null {
  const ta = toTime(a);
  const tb = toTime(b);
  if (ta === null) return tb === null ? null : b;
  if (tb === null) return a;
  return ta <= tb ? a : b;
}

export function computeTurn(input: TurnInput): TurnVerdict {
  const { contact, cache, tasks, calls, handoff, now, timeZone, settings } =
    input;

  const lastInbound = cache?.last_inbound_at ?? null;
  const lastOutbound = cache?.last_outbound_at ?? null;
  const leadState = cache?.lead_state ?? null;

  // ---- 1. Terminal ------------------------------------------------------
  // Callers filter these out before they ever get here. Handled anyway so
  // this function is total and can never return a Waiting row with no
  // reason, which is the one output shape section 1.3 forbids.
  if (!isTodayActive(contact.stage)) {
    return waiting(STAGE_LABELS[contact.stage], contact.stage_changed_at);
  }

  // ---- 2. A confirmed call is booked ------------------------------------
  // Past calls do not hold a lead in Waiting forever: once the time has gone
  // by, whatever happened on the call is the next thing that decides this.
  const booked = calls
    .filter((c) => c.status === "confirmed" && isFuture(c.scheduled_at, now))
    .sort((a, b) => toTime(a.scheduled_at)! - toTime(b.scheduled_at)!)[0];

  if (booked) {
    return waiting(
      `Call booked ${formatCallWhen(booked.scheduled_at, now, timeZone)}`,
      latest(lastInbound, lastOutbound) ?? contact.stage_changed_at,
    );
  }

  // ---- 3. Snoozed -------------------------------------------------------
  const snoozedUntil = leadState?.suppress_until ?? null;
  if (snoozedUntil && isFuture(snoozedUntil, now)) {
    return waiting(
      `Snoozed until ${formatShortDay(snoozedUntil, now, timeZone)}`,
      latest(lastInbound, lastOutbound) ?? contact.stage_changed_at,
    );
  }

  // ---- 4/5/6. The three ways a lead becomes Eddie's move -----------------
  const today = localDate(now, timeZone);
  const dueTasks = tasks
    .filter((t) => !t.is_done && t.due_date !== null && t.due_date <= today)
    .sort((a, b) => (a.due_date! < b.due_date! ? -1 : 1));

  const enteredNeedsQuote =
    contact.stage === "needs_quote" ? contact.stage_changed_at : null;

  const inboundIsLast =
    lastInbound !== null &&
    (lastOutbound === null || toTime(lastInbound)! > toTime(lastOutbound)!);

  if (dueTasks.length > 0 || enteredNeedsQuote || inboundIsLast) {
    /*
     * Section 1.2: the anchor is the more recent of "they messaged me" and "I
     * put this on the hit list", because both describe the moment the ball
     * landed in Eddie's court and the later one is when it most recently did.
     *
     * A task due date is a different kind of fact — a deadline, not an
     * arrival — so it is folded in with `earliest` instead. Without that, a
     * task five days overdue on a lead moved to Needs Quote an hour ago would
     * sort as an hour old and land at the bottom of the section it is most
     * urgent in.
     */
    let since = latest(inboundIsLast ? lastInbound : null, enteredNeedsQuote);

    if (dueTasks.length > 0) {
      const dueAt = startOfLocalDayUtc(
        dueTasks[0].due_date!,
        timeZone,
      ).toISOString();
      since = earliest(since, dueAt);
    }

    return {
      turn: "yours",
      section: "your_move",
      waiting_since: since,
      reason: null,
      overdue: false,
    };
  }

  // ---- 7. Handed off to a nurture campaign ------------------------------
  if (handoff) {
    const name = handoff.campaign_name ?? "a nurture campaign";
    return waiting(
      `In ${name} since ${formatShortDate(handoff.at, timeZone)}`,
      handoff.at,
    );
  }

  // ---- 8. Their move ----------------------------------------------------
  if (lastOutbound) {
    if (leadState?.recommended_action === "hold") {
      const angle = leadState.suggested_angle?.trim();
      return waiting(angle ? `On hold — ${angle}` : "On hold", lastOutbound);
    }

    const silentDays = localDaysSince(lastOutbound, now, timeZone) ?? 0;

    if (silentDays >= settings.overdueDays) {
      return {
        turn: "theirs",
        section: "their_move",
        waiting_since: lastOutbound,
        reason: null,
        overdue: true,
      };
    }

    /*
     * Not yet overdue. Section 2.4 puts it in Waiting rather than the
     * actionable section — visible, but not shouting.
     *
     * The spec's example reason here is "Replied 2 hours ago", which cannot
     * be right for this branch: a lead whose last message is inbound is
     * `yours` by rule 6 and never reaches it. What this branch actually
     * describes is a lead Eddie messaged and who has not answered yet, so the
     * reason says that instead.
     */
    const hours = describeHoursAgo(lastOutbound, now);
    const wait = describeWait(lastOutbound, now, timeZone);
    return {
      turn: "theirs",
      section: "waiting",
      waiting_since: lastOutbound,
      reason:
        silentDays < 1 ? `Messaged them ${hours}` : `Waiting on them ${wait}`,
      overdue: false,
    };
  }

  // ---- 9. Nothing known yet ---------------------------------------------
  // Split into two reasons because they need different fixes: one resolves
  // itself on the next sweep, the other needs the lead linked to Bonzo by
  // hand and would otherwise sit here silently forever.
  if (!contact.bonzo_prospect_id) {
    return waiting("Not linked to Bonzo", contact.stage_changed_at);
  }
  return waiting("No conversation history yet", contact.stage_changed_at);
}

function waiting(reason: string, since: string | null): TurnVerdict {
  return {
    turn: "waiting",
    section: "waiting",
    waiting_since: since,
    reason,
    overdue: false,
  };
}

/**
 * Sorts a section oldest-first — the thing that has waited longest is at the
 * top. Section 1.2 is emphatic that this is the entire prioritisation model
 * and that it should stay this simple.
 *
 * An unknown `waiting_since` sorts last rather than first: a null is an
 * absence of information, and letting it masquerade as infinitely old would
 * put the least-known leads above the most overdue ones.
 */
export function sortByWaiting<T extends { waiting_since: string | null }>(
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => {
    const ta = toTime(a.waiting_since);
    const tb = toTime(b.waiting_since);
    if (ta === null && tb === null) return 0;
    if (ta === null) return 1;
    if (tb === null) return -1;
    return ta - tb;
  });
}

export interface TodayBoard {
  your_move: TurnResult[];
  their_move: TurnResult[];
  waiting: TurnResult[];
  counts: {
    your_move: number;
    their_move: number;
    waiting: number;
    total: number;
  };
}

/**
 * Groups computed verdicts into the three Today sections.
 *
 * Every lead lands in exactly one, and the three counts sum to the total.
 * That invariant is the thing that would quietly destroy trust in the numbers
 * at the top of the screen (section 2.1), so it is structural here — a
 * `switch` over a closed union, not three independent filters that could
 * overlap or miss.
 */
export function groupToday(results: TurnResult[]): TodayBoard {
  const board: TodayBoard = {
    your_move: [],
    their_move: [],
    waiting: [],
    counts: { your_move: 0, their_move: 0, waiting: 0, total: results.length },
  };

  for (const r of results) {
    switch (r.section) {
      case "your_move":
        board.your_move.push(r);
        break;
      case "their_move":
        board.their_move.push(r);
        break;
      case "waiting":
        board.waiting.push(r);
        break;
    }
  }

  board.your_move = sortByWaiting(board.your_move);
  board.their_move = sortByWaiting(board.their_move);
  board.waiting = sortByWaiting(board.waiting);

  board.counts.your_move = board.your_move.length;
  board.counts.their_move = board.their_move.length;
  board.counts.waiting = board.waiting.length;

  return board;
}
