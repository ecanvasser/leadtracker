import { describe, it, expect } from "vitest";
import { instantForLocalTime } from "@/lib/calls/timezone";

const LA = "America/Los_Angeles";

const localParts = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));

/*
 * Manual booking converts a wall-clock time the broker typed into an instant.
 * It goes through the same helper the detector uses, so a call booked by hand
 * and one read out of a message cannot disagree — including across a DST
 * boundary, which is the case a naive `new Date(date + "T" + time)` gets wrong
 * twice a year.
 */
describe("booking a call at a local wall-clock time", () => {
  it("lands on the hour the broker typed", () => {
    const at = instantForLocalTime("2026-09-15", 14, 30, LA);
    expect(localParts(at.toISOString(), LA)).toBe("14:30");
  });

  it("holds the hour on the far side of the autumn DST change", () => {
    // PDT before, PST after. A fixed offset would slip this by an hour.
    const at = instantForLocalTime("2026-11-10", 9, 0, LA);
    expect(localParts(at.toISOString(), LA)).toBe("09:00");
  });

  it("holds the hour on the far side of the spring DST change", () => {
    const at = instantForLocalTime("2026-03-20", 9, 0, LA);
    expect(localParts(at.toISOString(), LA)).toBe("09:00");
  });

  it("resolves midnight without rolling into the previous day", () => {
    const at = instantForLocalTime("2026-09-15", 0, 0, LA);
    expect(
      new Intl.DateTimeFormat("en-CA", { timeZone: LA }).format(new Date(at.toISOString()))
    ).toBe("2026-09-15");
  });

  it("agrees with itself across zones for the same instant", () => {
    // The reminder shows both times; they must describe one moment.
    const at = instantForLocalTime("2026-09-15", 12, 0, LA);
    expect(localParts(at.toISOString(), LA)).toBe("12:00");
    expect(localParts(at.toISOString(), "America/New_York")).toBe("15:00");
  });
});

/*
 * The day-boundary bug, kept as a regression suite.
 *
 * The original helper corrected hour and minute but never the date, so any
 * local time earlier than the zone's UTC offset landed a day early — midnight
 * through 06:59 in California. It shipped in Phase 3 and would have produced a
 * reminder a day early for any lead who wrote "call me at 6am tomorrow".
 */
describe("every hour of the day resolves to the day that was asked for", () => {
  const zones = ["America/Los_Angeles", "America/New_York", "Asia/Tokyo", "Europe/London"];

  it.each(zones)("holds the date and hour across all 24 hours in %s", (tz) => {
    for (let hour = 0; hour < 24; hour++) {
      const at = instantForLocalTime("2026-09-15", hour, 0, tz);
      const rendered = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(at);

      expect(rendered).toContain("2026-09-15");
      expect(Number(rendered.split(", ")[1].split(":")[0]) % 24).toBe(hour);
    }
  });

  it("puts an early-morning call on the right side of midnight", () => {
    // The exact reported shape: 6am in Los Angeles, previously a day early.
    const at = instantForLocalTime("2026-09-15", 6, 0, "America/Los_Angeles");
    expect(
      new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(at)
    ).toBe("2026-09-15");
  });
});

