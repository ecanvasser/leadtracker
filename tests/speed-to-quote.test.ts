import { describe, it, expect } from "vitest";
import {
  formatSpeed,
  median,
  pairQuoteTimes,
  type Transition,
} from "@/lib/turn/speed";

const NOW = new Date("2026-09-30T18:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function t(contact: string, stage: string, at: string): Transition {
  return { contact_id: contact, to_stage: stage, changed_at: at };
}

describe("pairing quote times", () => {
  it("measures from entering Needs Quote to being quoted", () => {
    const hours = pairQuoteTimes(
      [t("c1", "needs_quote", hoursAgo(10)), t("c1", "quoted_follow_up", hoursAgo(6))],
      NOW
    );
    expect(hours).toEqual([4]);
  });

  it("ignores a lead still waiting to be quoted", () => {
    // Counting it as zero, or as "so far", would flatter the number.
    expect(pairQuoteTimes([t("c1", "needs_quote", hoursAgo(10))], NOW)).toEqual([]);
  });

  it("ignores a quote with no recorded Needs Quote before it", () => {
    // A lead dragged straight from Hot Lead to Quoted never had the clock
    // started, so there is nothing to measure.
    expect(
      pairQuoteTimes([t("c1", "quoted_follow_up", hoursAgo(6))], NOW)
    ).toEqual([]);
  });

  /*
   * A lead can make the trip more than once — quoted, gone quiet, revived
   * months later. Pairing by contact alone would measure the gap from the
   * first Needs Quote to the last quote, which is not a number about anything.
   */
  it("counts each trip through the funnel separately", () => {
    const hours = pairQuoteTimes(
      [
        t("c1", "needs_quote", hoursAgo(100)),
        t("c1", "quoted_follow_up", hoursAgo(98)),
        t("c1", "needs_quote", hoursAgo(10)),
        t("c1", "quoted_follow_up", hoursAgo(4)),
      ],
      NOW
    );
    expect(hours.sort((a, b) => a - b)).toEqual([2, 6]);
  });

  it("restarts the clock when a lead re-enters Needs Quote before any quote", () => {
    const hours = pairQuoteTimes(
      [
        t("c1", "needs_quote", hoursAgo(50)),
        t("c1", "needs_quote", hoursAgo(10)),
        t("c1", "quoted_follow_up", hoursAgo(7)),
      ],
      NOW
    );
    expect(hours).toEqual([3]);
  });

  it("keeps contacts separate", () => {
    const hours = pairQuoteTimes(
      [
        t("c1", "needs_quote", hoursAgo(10)),
        t("c2", "needs_quote", hoursAgo(8)),
        t("c2", "quoted_follow_up", hoursAgo(6)),
        t("c1", "quoted_follow_up", hoursAgo(5)),
      ],
      NOW
    );
    expect(hours.sort((a, b) => a - b)).toEqual([2, 5]);
  });

  it("takes transitions in any order", () => {
    const rows = [
      t("c1", "quoted_follow_up", hoursAgo(6)),
      t("c1", "needs_quote", hoursAgo(10)),
    ];
    expect(pairQuoteTimes(rows, NOW)).toEqual([4]);
  });
});

describe("the 30-day window", () => {
  it("excludes a quote sent before the window", () => {
    const hours = pairQuoteTimes(
      [
        t("c1", "needs_quote", daysAgo(41)),
        t("c1", "quoted_follow_up", daysAgo(40)),
      ],
      NOW
    );
    expect(hours).toEqual([]);
  });

  /*
   * The window applies to the quote, not to the Needs Quote entry. A lead that
   * sat for six weeks and was quoted yesterday is exactly the data point this
   * number exists to surface, and filtering it out for having started too
   * early would quietly remove the slowest quotes from a measure of slowness.
   */
  it("includes a long wait that ended inside the window", () => {
    const hours = pairQuoteTimes(
      [
        t("c1", "needs_quote", daysAgo(45)),
        t("c1", "quoted_follow_up", daysAgo(2)),
      ],
      NOW
    );
    expect(hours).toHaveLength(1);
    expect(Math.round(hours[0] / 24)).toBe(43);
  });
});

describe("median", () => {
  it("is null with nothing to measure", () => {
    expect(median([])).toBeNull();
  });

  it("takes the middle of an odd set", () => {
    expect(median([2, 8, 4])).toBe(4);
  });

  it("averages the two middles of an even set", () => {
    expect(median([2, 4, 6, 8])).toBe(5);
  });

  /*
   * Why median and not mean. One lead quoted three weeks late drags a mean
   * into meaninglessness, and that lead is exactly the kind that happens.
   */
  it("is not moved by a single outlier the way a mean would be", () => {
    const values = [3, 4, 4, 5, 500];
    expect(median(values)).toBe(4);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(mean).toBeGreaterThan(100);
  });
});

describe("formatting", () => {
  it("says nothing when there is nothing to say", () => {
    expect(formatSpeed(null)).toBeNull();
  });

  it("never renders a bare zero", () => {
    expect(formatSpeed(0)).toBe("under an hour");
    expect(formatSpeed(0.4)).toBe("under an hour");
  });

  it("uses hours while hours are readable", () => {
    expect(formatSpeed(1)).toBe("1 hour");
    expect(formatSpeed(4)).toBe("4 hours");
    expect(formatSpeed(47)).toBe("47 hours");
  });

  it("switches to days once hours stop being readable", () => {
    // "61 hours" makes you do arithmetic to learn it is two and a half days.
    expect(formatSpeed(61)).toBe("2.5 days");
  });
});
