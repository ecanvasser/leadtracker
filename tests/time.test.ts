import { describe, it, expect } from "vitest";
import {
  localDate,
  localDayOfWeek,
  isLocalSunday,
  isLocalSaturday,
  localTimeParts,
  isWithinLocalWindow,
  addLocalDays,
  daysBetweenLocalDates,
  leadAgeDays,
  startOfLocalDayUtc,
  endOfLocalDayUtc,
  safeTimezone,
  isValidTimezone,
  DEFAULT_TIMEZONE,
} from "@/lib/time";

const LA = "America/Los_Angeles";

describe("localDate", () => {
  // The headline bug: UTC rolls the day over at 5 PM Pacific during PDT,
  // which discarded the whole afternoon block.
  it("treats 5:30 PM Pacific as still today, not tomorrow", () => {
    // 2026-08-20 17:30 PDT === 2026-08-21 00:30 UTC
    const instant = new Date("2026-08-21T00:30:00Z");

    expect(instant.toISOString().split("T")[0]).toBe("2026-08-21"); // the old, wrong answer
    expect(localDate(instant, LA)).toBe("2026-08-20"); // the correct local answer
  });

  it("treats 11:59 PM Pacific as still the same local day", () => {
    const instant = new Date("2026-08-21T06:59:00Z"); // 23:59 PDT on the 20th
    expect(localDate(instant, LA)).toBe("2026-08-20");
  });

  it("rolls over at local midnight, not UTC midnight", () => {
    const justBefore = new Date("2026-08-21T06:59:59Z"); // 23:59:59 PDT
    const justAfter = new Date("2026-08-21T07:00:00Z"); // 00:00:00 PDT
    expect(localDate(justBefore, LA)).toBe("2026-08-20");
    expect(localDate(justAfter, LA)).toBe("2026-08-21");
  });

  it("handles PST (winter, UTC-8) as well as PDT (summer, UTC-7)", () => {
    // 2026-01-15 16:30 PST === 2026-01-16 00:30 UTC
    const winter = new Date("2026-01-16T00:30:00Z");
    expect(winter.toISOString().split("T")[0]).toBe("2026-01-16");
    expect(localDate(winter, LA)).toBe("2026-01-15");
  });

  it("agrees with UTC when the zone is UTC", () => {
    const instant = new Date("2026-08-20T18:00:00Z");
    expect(localDate(instant, "UTC")).toBe("2026-08-20");
  });
});

describe("localDayOfWeek", () => {
  it("reports the local weekday, not the UTC one", () => {
    // 2026-08-22 is a Saturday. At 5:30 PM Pacific it is already Sunday in UTC.
    const instant = new Date("2026-08-23T00:30:00Z");
    expect(instant.getUTCDay()).toBe(0); // UTC says Sunday
    expect(localDayOfWeek(instant, LA)).toBe(6); // locally it is still Saturday
    expect(isLocalSaturday(instant, LA)).toBe(true);
    expect(isLocalSunday(instant, LA)).toBe(false);
  });

  it("identifies a genuine local Sunday", () => {
    const instant = new Date("2026-08-23T19:00:00Z"); // noon PDT on Sunday
    expect(isLocalSunday(instant, LA)).toBe(true);
  });
});

describe("localTimeParts", () => {
  it("returns local wall-clock hour", () => {
    const instant = new Date("2026-08-21T00:30:00Z");
    expect(localTimeParts(instant, LA)).toEqual({ hour: 17, minute: 30 });
  });

  it("uses a 24-hour clock so midnight is 0 and not 24", () => {
    const instant = new Date("2026-08-21T07:00:00Z"); // midnight PDT
    expect(localTimeParts(instant, LA).hour).toBe(0);
  });
});

describe("isWithinLocalWindow", () => {
  it("handles a normal same-day window", () => {
    const noon = new Date("2026-08-20T19:00:00Z"); // 12:00 PDT
    expect(isWithinLocalWindow("08:00", "19:00", noon, LA)).toBe(true);
  });

  it("excludes times outside a same-day window", () => {
    const earlyAm = new Date("2026-08-20T13:00:00Z"); // 06:00 PDT
    expect(isWithinLocalWindow("08:00", "19:00", earlyAm, LA)).toBe(false);
  });

  it("handles a quiet-hours window that wraps midnight", () => {
    const lateNight = new Date("2026-08-21T05:00:00Z"); // 22:00 PDT
    const midMorning = new Date("2026-08-20T17:00:00Z"); // 10:00 PDT
    expect(isWithinLocalWindow("21:00", "08:00", lateNight, LA)).toBe(true);
    expect(isWithinLocalWindow("21:00", "08:00", midMorning, LA)).toBe(false);
  });

  it("treats the window boundaries as inclusive start, exclusive end", () => {
    const eightAm = new Date("2026-08-20T15:00:00Z"); // 08:00 PDT
    const sevenPm = new Date("2026-08-21T02:00:00Z"); // 19:00 PDT
    expect(isWithinLocalWindow("08:00", "19:00", eightAm, LA)).toBe(true);
    expect(isWithinLocalWindow("08:00", "19:00", sevenPm, LA)).toBe(false);
  });

  it("accepts Postgres time values with seconds", () => {
    const noon = new Date("2026-08-20T19:00:00Z");
    expect(isWithinLocalWindow("08:00:00", "19:00:00", noon, LA)).toBe(true);
  });
});

describe("addLocalDays / daysBetweenLocalDates", () => {
  it("adds days without any timezone drift", () => {
    expect(addLocalDays("2026-08-20", 1)).toBe("2026-08-21");
    expect(addLocalDays("2026-08-20", -1)).toBe("2026-08-19");
  });

  it("crosses month and year boundaries", () => {
    expect(addLocalDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(addLocalDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("crosses a DST boundary without losing or gaining a day", () => {
    // US DST ends 2026-11-01. Stepping across it must stay exact.
    expect(addLocalDays("2026-10-31", 2)).toBe("2026-11-02");
    expect(daysBetweenLocalDates("2026-10-31", "2026-11-02")).toBe(2);
  });

  it("counts whole days between dates", () => {
    expect(daysBetweenLocalDates("2026-08-20", "2026-08-20")).toBe(0);
    expect(daysBetweenLocalDates("2026-08-20", "2026-09-19")).toBe(30);
  });
});

describe("leadAgeDays", () => {
  it("counts a lead created today as Day 0", () => {
    const created = "2026-08-20T16:00:00Z"; // 09:00 PDT
    const now = new Date("2026-08-21T00:30:00Z"); // 17:30 PDT same local day
    expect(leadAgeDays(created, LA, now)).toBe(0);
  });

  it("counts calendar days, so an 11 PM lead is Day 1 the next morning", () => {
    const created = "2026-08-21T06:00:00Z"; // 23:00 PDT on the 20th
    const now = new Date("2026-08-21T16:00:00Z"); // 09:00 PDT on the 21st
    expect(leadAgeDays(created, LA, now)).toBe(1);
  });

  it("never returns a negative age for a clock-skewed future timestamp", () => {
    const created = "2026-08-25T16:00:00Z";
    const now = new Date("2026-08-20T16:00:00Z");
    expect(leadAgeDays(created, LA, now)).toBe(0);
  });

  it("would misreport age if computed in UTC", () => {
    // Created 17:30 PDT on the 20th, evaluated 09:00 PDT on the 21st.
    // Local: Day 1. Naive UTC date math: also 1 here — but the local answer
    // stays correct across the 5 PM boundary where UTC has already advanced.
    const created = "2026-08-21T00:30:00Z";
    const now = new Date("2026-08-21T16:00:00Z");
    expect(leadAgeDays(created, LA, now)).toBe(1);
    // Same lead evaluated 30 minutes after creation is still Day 0 locally,
    // even though the UTC date already changed.
    expect(leadAgeDays(created, LA, new Date("2026-08-21T01:00:00Z"))).toBe(0);
  });
});

describe("startOfLocalDayUtc / endOfLocalDayUtc", () => {
  it("returns the correct UTC instant for local midnight in PDT", () => {
    expect(startOfLocalDayUtc("2026-08-20", LA).toISOString()).toBe(
      "2026-08-20T07:00:00.000Z"
    );
  });

  it("returns the correct UTC instant for local midnight in PST", () => {
    expect(startOfLocalDayUtc("2026-01-15", LA).toISOString()).toBe(
      "2026-01-15T08:00:00.000Z"
    );
  });

  it("spans exactly 24 hours on a normal day", () => {
    const start = startOfLocalDayUtc("2026-08-20", LA);
    const end = endOfLocalDayUtc("2026-08-20", LA);
    expect(end.getTime() - start.getTime()).toBe(24 * 3600 * 1000);
  });

  it("spans 23 hours on the spring-forward day", () => {
    // 2026-03-08 is the US spring-forward date.
    const start = startOfLocalDayUtc("2026-03-08", LA);
    const end = endOfLocalDayUtc("2026-03-08", LA);
    expect(end.getTime() - start.getTime()).toBe(23 * 3600 * 1000);
  });

  it("spans 25 hours on the fall-back day", () => {
    // 2026-11-01 is the US fall-back date.
    const start = startOfLocalDayUtc("2026-11-01", LA);
    const end = endOfLocalDayUtc("2026-11-01", LA);
    expect(end.getTime() - start.getTime()).toBe(25 * 3600 * 1000);
  });

  it("brackets an instant into the local day it belongs to", () => {
    const instant = new Date("2026-08-21T00:30:00Z"); // 17:30 PDT on the 20th
    const start = startOfLocalDayUtc("2026-08-20", LA);
    const end = endOfLocalDayUtc("2026-08-20", LA);
    expect(instant >= start && instant < end).toBe(true);
  });
});

describe("timezone validation", () => {
  it("accepts real IANA zones", () => {
    expect(isValidTimezone("America/Los_Angeles")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
  });

  it("rejects nonsense", () => {
    expect(isValidTimezone("Pacific Time")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });

  // Abbreviations are rejected outright. Intl accepts them, but what they
  // resolve to is not stable across ICU versions — verified across a
  // Node 22 (ICU 74) -> Node 26 (ICU 78) upgrade:
  //   "EST"     ICU 74 -> Etc/GMT+5  ICU 78 -> America/Panama
  //   "PST8PDT" ICU 74 -> PST8PDT    ICU 78 -> America/Los_Angeles
  // America/Panama is a real Region/City zone, so a check based on the
  // resolved value would let "EST" through — yet it is permanently UTC-5 and
  // someone meaning US Eastern would be an hour off for half the year.
  it("rejects bare timezone abbreviations", () => {
    expect(isValidTimezone("EST")).toBe(false);
    expect(isValidTimezone("PST")).toBe(false);
    expect(isValidTimezone("MST")).toBe(false);
    expect(isValidTimezone("HST")).toBe(false);
    expect(isValidTimezone("PST8PDT")).toBe(false);
    expect(isValidTimezone("EST5EDT")).toBe(false);
    expect(safeTimezone("EST")).toBe(DEFAULT_TIMEZONE);
  });

  it("rejects fixed-offset pseudo-zones that never observe DST", () => {
    expect(isValidTimezone("Etc/GMT+5")).toBe(false);
    expect(isValidTimezone("Etc/UTC")).toBe(false);
  });

  it("accepts the Region/City zones a user should actually be setting", () => {
    expect(isValidTimezone("America/Los_Angeles")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("America/Phoenix")).toBe(true);
    expect(isValidTimezone("Pacific/Honolulu")).toBe(true);
    expect(isValidTimezone("Europe/London")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
  });

  // The property that actually matters, stated directly.
  it("accepts a zone that tracks DST and one that legitimately does not", () => {
    const janHour = (tz: string) =>
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" })
        .formatToParts(new Date("2026-01-15T18:00:00Z"))
        .find((p) => p.type === "hour")!.value;
    const julHour = (tz: string) =>
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" })
        .formatToParts(new Date("2026-07-15T18:00:00Z"))
        .find((p) => p.type === "hour")!.value;

    // New York shifts; Phoenix does not. Both are valid inputs.
    expect(janHour("America/New_York")).not.toBe(julHour("America/New_York"));
    expect(janHour("America/Phoenix")).toBe(julHour("America/Phoenix"));
    expect(isValidTimezone("America/Phoenix")).toBe(true);
  });

  it("falls back to the default rather than throwing", () => {
    expect(safeTimezone(null)).toBe(DEFAULT_TIMEZONE);
    expect(safeTimezone("Not/AZone")).toBe(DEFAULT_TIMEZONE);
    expect(safeTimezone("America/Chicago")).toBe("America/Chicago");
  });
});
