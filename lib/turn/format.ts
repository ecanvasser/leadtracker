/**
 * Plain-words durations and dates for Today rows and Waiting reasons.
 *
 * The rule that drives all of this, established in Phase 7 and restated in
 * section 2.2: **never render "0 days."** It reads as *just happened* and
 * buries the thing that is most overdue. When a duration is unknown these
 * return null and the caller omits the element entirely; when it is under a
 * day they say "today".
 */

import { DEFAULT_TIMEZONE, daysBetweenLocalDates, localDate } from "@/lib/time";

const HOUR_MS = 3_600_000;

/** Whole local calendar days between an instant and now. Null when unknown. */
export function localDaysSince(
  from: string | Date | null | undefined,
  now: Date,
  timeZone: string = DEFAULT_TIMEZONE
): number | null {
  if (!from) return null;
  const t = new Date(from).getTime();
  if (!Number.isFinite(t)) return null;
  return daysBetweenLocalDates(
    localDate(new Date(t), timeZone),
    localDate(now, timeZone)
  );
}

/**
 * "3 days" · "yesterday" · "today" · "since Aug 14" · null.
 *
 * Calendar days rather than elapsed hours, because that is how a person reads
 * a pipeline: something that arrived at 11pm last night is "yesterday" this
 * morning, not "9 hours".
 */
export function describeWait(
  from: string | Date | null | undefined,
  now: Date,
  timeZone: string = DEFAULT_TIMEZONE
): string | null {
  const days = localDaysSince(from, now, timeZone);
  if (days === null) return null;
  // A future timestamp is a clock skew or a bad row, not a negative wait.
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days`;
  return `since ${formatShortDate(from as string | Date, timeZone)}`;
}

/** "2 hours ago" · "45 minutes ago" · "just now". */
export function describeHoursAgo(from: string | Date, now: Date): string {
  const ms = now.getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const hours = Math.floor(ms / HOUR_MS);
  if (hours < 1) {
    const minutes = Math.floor(ms / 60_000);
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

/** "Aug 14" */
export function formatShortDate(
  instant: string | Date,
  timeZone: string = DEFAULT_TIMEZONE
): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
  }).format(new Date(instant));
}


/**
 * A near-future day the way it would be said out loud: "today", "tomorrow",
 * "Monday", or a date once the weekday stops being unambiguous.
 */
export function formatShortDay(
  instant: string | Date,
  now: Date,
  timeZone: string = DEFAULT_TIMEZONE
): string {
  const at = new Date(instant);
  const days = daysBetweenLocalDates(
    localDate(now, timeZone),
    localDate(at, timeZone)
  );
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days > 1 && days < 7) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
    }).format(at);
  }
  return formatShortDate(at, timeZone);
}

/** "Thursday 2pm" — a booked call read the way it was agreed to.
 *
 * Beyond a week out the weekday stops being useful ("Thursday" three weeks
 * from now is a trap), so it switches to a date.
 */
export function formatCallWhen(
  instant: string | Date,
  now: Date,
  timeZone: string = DEFAULT_TIMEZONE
): string {
  const at = new Date(instant);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  })
    .format(at)
    // "2:00 PM" -> "2pm"; a booked call at half past keeps its minutes.
    .replace(":00", "")
    .replace(" AM", "am")
    .replace(" PM", "pm");

  const days = daysBetweenLocalDates(
    localDate(now, timeZone),
    localDate(at, timeZone)
  );

  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days > 1 && days < 7) {
    const weekday = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
    }).format(at);
    return `${weekday} ${time}`;
  }
  return `${formatShortDate(at, timeZone)} ${time}`;
}
