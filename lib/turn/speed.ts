/**
 * Speed to quote — Phase 8 section 4.
 *
 * Median hours from a lead entering Needs Quote to being pitched, over the
 * last 30 days, with the count it is based on.
 *
 * One number, deliberately. Section 7 rules out a dashboard, and the reasoning
 * holds: if the median is four hours Eddie is competitive, and if it is two
 * days he is losing deals to whoever quoted first — and no amount of follow-up
 * automation fixes that. A chart would not tell him anything the number does
 * not.
 *
 * Median rather than mean because one lead quoted three weeks late would drag
 * a mean into meaninglessness, and that lead is exactly the kind that happens.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** How far back the number looks. */
export const SPEED_WINDOW_DAYS = 30;

/**
 * A transition row, reduced to what pairing needs.
 * Exported so the pairing can be tested without a database.
 */
export interface Transition {
  contact_id: string;
  to_stage: string;
  changed_at: string;
}

export interface SpeedToQuote {
  /** Null when nothing has completed the journey yet. */
  medianHours: number | null;
  /** How many quotes the median is based on. Shown alongside it, always. */
  count: number;
  windowDays: number;
}

/**
 * Pairs each entry into Needs Quote with the next entry into Quoted.
 *
 * Per contact and in order, because a lead can make the trip more than once —
 * quoted, gone quiet, revived months later — and each trip is its own
 * observation. Pairing by contact alone would silently measure the gap from
 * the first Needs Quote to the last quote.
 *
 * An unmatched Needs Quote is not a data point: the lead has not been quoted
 * yet, and counting it as zero or as "so far" would flatter the number.
 */
export function pairQuoteTimes(
  transitions: Transition[],
  now: Date,
  windowDays: number = SPEED_WINDOW_DAYS
): number[] {
  const byContact = new Map<string, Transition[]>();
  for (const t of transitions) {
    const list = byContact.get(t.contact_id) ?? [];
    list.push(t);
    byContact.set(t.contact_id, list);
  }

  const cutoff = now.getTime() - windowDays * 86_400_000;
  const hours: number[] = [];

  for (const rows of byContact.values()) {
    const ordered = [...rows].sort(
      (a, b) => new Date(a.changed_at).getTime() - new Date(b.changed_at).getTime()
    );

    let openedAt: number | null = null;
    for (const row of ordered) {
      const at = new Date(row.changed_at).getTime();
      if (!Number.isFinite(at)) continue;

      if (row.to_stage === "needs_quote") {
        // A second entry into Needs Quote before any quote replaces the first.
        // The clock that matters is the one still running.
        openedAt = at;
      } else if (row.to_stage === "quoted_follow_up" && openedAt !== null) {
        /*
         * The window is applied to the quote, not to the Needs Quote entry.
         * "Median time to quote over the last 30 days" is about quotes sent in
         * that period; a lead that sat for six weeks and was quoted yesterday
         * is a data point Eddie needs to see, not one to filter out for being
         * old.
         */
        if (at >= cutoff) {
          hours.push((at - openedAt) / 3_600_000);
        }
        openedAt = null;
      }
    }
  }

  return hours;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export async function loadSpeedToQuote(
  supabase: SupabaseClient,
  userId: string,
  now: Date = new Date()
): Promise<SpeedToQuote> {
  /*
   * Reaches back further than the window so a Needs Quote entry that predates
   * it can still pair with a quote inside it. Without the extra reach, a lead
   * that waited a long time would be dropped for having started too early —
   * which would quietly remove the slowest quotes from a number whose whole
   * purpose is to notice slowness.
   */
  const lookback = new Date(now.getTime() - SPEED_WINDOW_DAYS * 3 * 86_400_000);

  const { data } = await supabase
    .from("stage_transitions")
    .select("contact_id, to_stage, changed_at")
    .eq("user_id", userId)
    .in("to_stage", ["needs_quote", "quoted_follow_up"])
    .gte("changed_at", lookback.toISOString())
    .order("changed_at", { ascending: true });

  const hours = pairQuoteTimes((data ?? []) as Transition[], now);

  return {
    medianHours: median(hours),
    count: hours.length,
    windowDays: SPEED_WINDOW_DAYS,
  };
}

/**
 * "4 hours" · "2.5 days" · null.
 *
 * Switches to days past 48 hours, where hours stop being readable — "61 hours"
 * makes you do arithmetic to learn it is two and a half days. Null when there
 * is nothing to report, so the caller omits the whole thing rather than
 * printing a zero, which section 2.2 rules out everywhere else too.
 */
export function formatSpeed(medianHours: number | null): string | null {
  if (medianHours === null || !Number.isFinite(medianHours)) return null;
  if (medianHours < 1) return "under an hour";
  if (medianHours < 48) {
    const h = Math.round(medianHours);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const days = medianHours / 24;
  return `${days.toFixed(1)} days`;
}
