/**
 * Local-timezone date handling.
 *
 * Everything in this app that asks "what day is it" must go through here.
 *
 * The bug this replaces: every queue route computed today with
 * `new Date().toISOString().split("T")[0]`, and daily_queue.queue_date
 * defaulted to Postgres CURRENT_DATE. Both are UTC. In America/Los_Angeles
 * that rolls the day over at 5:00 PM local (4:00 PM during PST), which
 * silently discarded the entire afternoon block while the completion screen
 * still said "check back this afternoon".
 *
 * Implementation note: this uses Intl, which ships with Node and the browser
 * and carries the full IANA database including DST rules. No dependency.
 */

import { createServiceClient } from "@/lib/supabase/service";

export const DEFAULT_TIMEZONE = "America/Los_Angeles";

/** A calendar date with no time and no zone, formatted YYYY-MM-DD. */
export type LocalDate = string;

/**
 * en-CA formats as YYYY-MM-DD, which is the format Postgres `date` columns
 * and every existing query in this codebase already use.
 */
function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/**
 * Throws on an invalid IANA zone rather than silently falling back, so a typo
 * in user_settings surfaces immediately instead of producing dates that are
 * quietly wrong. Callers that need resilience use `safeTimezone` first.
 */
export function assertValidTimezone(timeZone: string): void {
  try {
    dateFormatter(timeZone).format(new Date());
  } catch {
    throw new Error(`Invalid IANA timezone: ${timeZone}`);
  }
}

/**
 * Accepts only zones that actually track DST.
 *
 * Intl is more permissive than it looks: "EST" is accepted but resolves to
 * Etc/GMT+5, a *fixed* offset that never observes daylight saving, so a user
 * who typed it would be an hour off for half the year. "PST8PDT" is similar
 * legacy baggage. Both are rejected here in favour of a real Region/City zone.
 * ("PST" itself resolves to America/Los_Angeles and is therefore fine.)
 */
export function isValidTimezone(timeZone: string): boolean {
  let resolved: string;
  try {
    resolved = dateFormatter(timeZone).resolvedOptions().timeZone;
  } catch {
    return false;
  }
  if (resolved === "UTC") return true;
  if (resolved.startsWith("Etc/")) return false;
  // A canonical IANA zone is always Region/City (optionally Region/Sub/City).
  return resolved.includes("/");
}

/** Falls back to the default zone if the stored value is unusable. */
export function safeTimezone(timeZone: string | null | undefined): string {
  if (!timeZone) return DEFAULT_TIMEZONE;
  return isValidTimezone(timeZone) ? timeZone : DEFAULT_TIMEZONE;
}

/** The calendar date at `instant` as observed in `timeZone`. */
export function localDate(
  instant: Date | string | number = new Date(),
  timeZone: string = DEFAULT_TIMEZONE
): LocalDate {
  const d = instant instanceof Date ? instant : new Date(instant);
  return dateFormatter(timeZone).format(d);
}

/** Day of week in `timeZone`: 0 = Sunday … 6 = Saturday. */
export function localDayOfWeek(
  instant: Date | string | number = new Date(),
  timeZone: string = DEFAULT_TIMEZONE
): number {
  const d = instant instanceof Date ? instant : new Date(instant);
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(d);
  const index = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
  if (index === -1) throw new Error(`Could not resolve weekday in ${timeZone}`);
  return index;
}

export function isLocalSunday(
  instant: Date | string | number = new Date(),
  timeZone: string = DEFAULT_TIMEZONE
): boolean {
  return localDayOfWeek(instant, timeZone) === 0;
}

export function isLocalSaturday(
  instant: Date | string | number = new Date(),
  timeZone: string = DEFAULT_TIMEZONE
): boolean {
  return localDayOfWeek(instant, timeZone) === 6;
}

/** Local wall-clock hour and minute, for quiet-hours and working-hours gates. */
export function localTimeParts(
  instant: Date | string | number = new Date(),
  timeZone: string = DEFAULT_TIMEZONE
): { hour: number; minute: number } {
  const d = instant instanceof Date ? instant : new Date(instant);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return { hour, minute };
}

/** Minutes since local midnight — the easiest form to compare time windows in. */
export function localMinutesSinceMidnight(
  instant: Date | string | number = new Date(),
  timeZone: string = DEFAULT_TIMEZONE
): number {
  const { hour, minute } = localTimeParts(instant, timeZone);
  return hour * 60 + minute;
}

/** Parses a Postgres `time` value ("08:00" / "08:00:00") to minutes. */
export function parseTimeToMinutes(value: string): number {
  const [h, m] = value.split(":");
  return Number(h) * 60 + Number(m ?? 0);
}

/**
 * Whether `instant` falls inside a local time window.
 * Windows that wrap midnight (quiet hours 21:00 → 08:00) are handled.
 */
export function isWithinLocalWindow(
  startTime: string,
  endTime: string,
  instant: Date | string | number = new Date(),
  timeZone: string = DEFAULT_TIMEZONE
): boolean {
  const now = localMinutesSinceMidnight(instant, timeZone);
  const start = parseTimeToMinutes(startTime);
  const end = parseTimeToMinutes(endTime);
  if (start === end) return true;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}

/** Shifts a YYYY-MM-DD by whole calendar days without any zone involvement. */
export function addLocalDays(date: LocalDate, days: number): LocalDate {
  const [y, m, d] = date.split("-").map(Number);
  // UTC arithmetic on a date-only value is safe: there is no zone to shift.
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/**
 * Whole calendar days between two local dates.
 * Used for lead age, so "Day 0" means "the calendar day the lead came in".
 */
export function daysBetweenLocalDates(from: LocalDate, to: LocalDate): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const a = Date.UTC(fy, fm - 1, fd);
  const b = Date.UTC(ty, tm - 1, td);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Lead age in local calendar days. A lead created yesterday at 11 PM is Day 1
 * this morning, which is how a person reads a pipeline — not 9 hours old.
 */
export function leadAgeDays(
  createdAt: string | Date,
  timeZone: string = DEFAULT_TIMEZONE,
  now: Date = new Date()
): number {
  return Math.max(
    0,
    daysBetweenLocalDates(
      localDate(createdAt, timeZone),
      localDate(now, timeZone)
    )
  );
}

/**
 * The UTC instant at which a local calendar day begins.
 *
 * Needed for range queries: selecting "rows created today" against a
 * timestamptz column requires real UTC bounds, not a date string comparison.
 * Resolved by probing the zone's offset at that moment, so DST transitions
 * land on the correct instant.
 */
export function startOfLocalDayUtc(
  date: LocalDate,
  timeZone: string = DEFAULT_TIMEZONE
): Date {
  const [y, m, d] = date.split("-").map(Number);
  // First guess: treat the wall-clock time as if it were UTC.
  const guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  // Then correct by the zone's actual offset at that instant, twice, so a
  // guess that lands on the wrong side of a DST boundary still converges.
  let result = guess;
  for (let i = 0; i < 2; i++) {
    const offset = timezoneOffsetMs(result, timeZone);
    result = new Date(guess.getTime() - offset);
  }
  return result;
}

export function endOfLocalDayUtc(
  date: LocalDate,
  timeZone: string = DEFAULT_TIMEZONE
): Date {
  return startOfLocalDayUtc(addLocalDays(date, 1), timeZone);
}

/** The zone's UTC offset in milliseconds at a given instant. */
export function timezoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  );
  return asUtc - instant.getTime();
}

/**
 * Formats an instant as local wall-clock time for display, e.g. "2:00 PM PT".
 * Used by call reminders, which must always show both parties' times.
 */
export function formatLocalTime(
  instant: Date | string | number,
  timeZone: string = DEFAULT_TIMEZONE,
  opts: { weekday?: boolean } = {}
): string {
  const d = instant instanceof Date ? instant : new Date(instant);
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    ...(opts.weekday ? { weekday: "short" as const } : {}),
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(d);
}

// ---------------------------------------------------------------------------
// User-scoped helpers
// ---------------------------------------------------------------------------

/**
 * Per-request memo. Settings change rarely and a single queue generation reads
 * the timezone once per contact; without this that is one round trip each.
 */
const timezoneCache = new Map<string, { tz: string; at: number }>();
const TIMEZONE_TTL_MS = 60_000;

export function clearTimezoneCache(): void {
  timezoneCache.clear();
}

/** Resolves a user's configured timezone, falling back to the default. */
export async function getUserTimezone(userId: string): Promise<string> {
  const hit = timezoneCache.get(userId);
  if (hit && Date.now() - hit.at < TIMEZONE_TTL_MS) return hit.tz;

  const supabase = createServiceClient();
  const { data } = await supabase
    .from("user_settings")
    .select("timezone")
    .eq("user_id", userId)
    .maybeSingle();

  const tz = safeTimezone(data?.timezone);
  timezoneCache.set(userId, { tz, at: Date.now() });
  return tz;
}

/**
 * "Today" for a user, as a YYYY-MM-DD string.
 *
 * Accepts either a user id or an IANA zone so callers that already hold the
 * zone (the worker, the cadence engine) skip the lookup entirely.
 */
export async function localDateFor(
  userIdOrTz: string,
  now: Date = new Date()
): Promise<LocalDate> {
  const tz = isValidTimezone(userIdOrTz)
    ? userIdOrTz
    : await getUserTimezone(userIdOrTz);
  return localDate(now, tz);
}
