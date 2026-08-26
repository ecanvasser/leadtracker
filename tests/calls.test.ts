import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  stateFromAddress,
  areaCodeFromPhone,
  resolveProspectTimezone,
  formatBothZones,
  instantForLocalTime,
  formatInZone,
} from "@/lib/calls/timezone";
import {

  candidateToInstant,
} from "@/lib/calls/detect";

const LA = "America/Los_Angeles";

describe("stateFromAddress", () => {
  it("reads a trailing state abbreviation with a ZIP", () => {
    expect(stateFromAddress("1400 Elm St, Dallas, TX 75201")).toBe("TX");
  });

  it("reads a trailing abbreviation with no ZIP", () => {
    expect(stateFromAddress("42 Beacon Street, Boston, MA")).toBe("MA");
  });

  it("reads a spelled-out state", () => {
    expect(stateFromAddress("88 Ocean Ave, Portland, Oregon 97201")).toBe("OR");
  });

  it("handles a two-word state name", () => {
    expect(stateFromAddress("9 Pine Rd, Manchester, New Hampshire")).toBe("NH");
  });

  it("returns null when there is no state", () => {
    expect(stateFromAddress("123 Main St")).toBeNull();
    expect(stateFromAddress(null)).toBeNull();
    expect(stateFromAddress("")).toBeNull();
  });

  it("does not mistake a random two-letter word for a state", () => {
    expect(stateFromAddress("PO Box 12")).toBeNull();
  });
});

describe("areaCodeFromPhone", () => {
  it("reads common US formats", () => {
    expect(areaCodeFromPhone("(214) 555-0198")).toBe("214");
    expect(areaCodeFromPhone("214-555-0198")).toBe("214");
    expect(areaCodeFromPhone("2145550198")).toBe("214");
    expect(areaCodeFromPhone("+1 214 555 0198")).toBe("214");
    expect(areaCodeFromPhone("1-214-555-0198")).toBe("214");
  });

  it("rejects a number that is not a NANP length", () => {
    expect(areaCodeFromPhone("555-0198")).toBeNull();
    expect(areaCodeFromPhone("+44 20 7946 0958")).toBeNull();
  });

  it("rejects an area code starting with 0 or 1, which cannot exist", () => {
    expect(areaCodeFromPhone("0145550198")).toBeNull();
    expect(areaCodeFromPhone("1145550198")).toBeNull();
  });

  it("handles null and empty", () => {
    expect(areaCodeFromPhone(null)).toBeNull();
    expect(areaCodeFromPhone("")).toBeNull();
  });
});

// Getting this wrong does not produce a slightly-off reminder. It produces a
// missed call.
describe("resolveProspectTimezone", () => {
  it("prefers the property address over the area code", () => {
    // A Texas property with a California mobile: the property wins, because a
    // mobile number keeps its area code across a move.
    const r = resolveProspectTimezone({
      propertyAddress: "1400 Elm St, Dallas, TX 75201",
      phone: "(415) 555-0198",
      brokerTimezone: LA,
    });
    expect(r.timeZone).toBe("America/Chicago");
    expect(r.source).toBe("property_state");
    expect(r.detail).toContain("TX");
  });

  it("falls back to the area code when there is no address", () => {
    const r = resolveProspectTimezone({
      propertyAddress: null,
      phone: "(212) 555-0198",
      brokerTimezone: LA,
    });
    expect(r.timeZone).toBe("America/New_York");
    expect(r.source).toBe("area_code");
    expect(r.detail).toContain("212");
  });

  it("falls back to the broker's zone when nothing is known", () => {
    const r = resolveProspectTimezone({
      propertyAddress: null,
      phone: null,
      brokerTimezone: LA,
    });
    expect(r.timeZone).toBe(LA);
    expect(r.source).toBe("broker_default");
    // The reminder must say this was a guess.
    expect(r.detail).toContain("assumed");
  });

  it("falls through an unrecognised address to the area code", () => {
    const r = resolveProspectTimezone({
      propertyAddress: "somewhere nice",
      phone: "(312) 555-0198",
      brokerTimezone: LA,
    });
    expect(r.source).toBe("area_code");
    expect(r.timeZone).toBe("America/Chicago");
  });

  it("maps Arizona to Phoenix, which does not observe DST", () => {
    const r = resolveProspectTimezone({
      propertyAddress: "1 Camelback Rd, Phoenix, AZ 85012",
      phone: null,
      brokerTimezone: LA,
    });
    expect(r.timeZone).toBe("America/Phoenix");
  });
});

describe("formatBothZones", () => {
  // 2026-08-20 21:00 UTC = 14:00 PDT = 16:00 CDT
  const instant = new Date("2026-08-20T21:00:00Z");

  it("shows their time and yours when the zones differ", () => {
    const text = formatBothZones(instant, "America/Chicago", LA);
    expect(text).toContain("4:00 PM");
    expect(text).toContain("2:00 PM");
    expect(text).toContain("their time");
    expect(text).toContain("yours");
  });

  it("says so plainly when both are in the same zone", () => {
    const text = formatBothZones(instant, LA, LA);
    expect(text).toContain("same time");
    expect(text).not.toContain("their time");
  });

  it("never prints a bare time with no zone label", () => {
    const text = formatBothZones(instant, "America/New_York", LA);
    expect(text).toMatch(/[A-Z]{2,4}T?\b/);
  });
});

// Storing an offset instead of a zone is the classic version of this bug: it
// is right today and an hour wrong after the next transition.
describe("instantForLocalTime across DST", () => {
  it("builds 2pm local in summer", () => {
    const i = instantForLocalTime("2026-08-20", 14, 0, LA);
    expect(formatInZone(i, LA)).toContain("2:00 PM");
  });

  it("builds 2pm local in winter, after the fall transition", () => {
    const i = instantForLocalTime("2026-12-10", 14, 0, LA);
    expect(formatInZone(i, LA)).toContain("2:00 PM");
  });

  it("gives different UTC instants for the same wall clock either side of DST", () => {
    const summer = instantForLocalTime("2026-08-20", 14, 0, LA);
    const winter = instantForLocalTime("2026-12-10", 14, 0, LA);
    expect(summer.getUTCHours()).not.toBe(winter.getUTCHours());
  });

  it("holds 2pm local the day after the fall-back transition", () => {
    // Pacific falls back 2026-11-01.
    const i = instantForLocalTime("2026-11-02", 14, 0, LA);
    expect(formatInZone(i, LA)).toContain("2:00 PM");
  });

  it("holds 9am local the day after the spring-forward transition", () => {
    // Pacific springs forward 2026-03-08.
    const i = instantForLocalTime("2026-03-09", 9, 0, LA);
    expect(formatInZone(i, LA)).toContain("9:00 AM");
  });

  it("holds the hour in a zone that does not observe DST", () => {
    const summer = instantForLocalTime("2026-08-20", 14, 0, "America/Phoenix");
    const winter = instantForLocalTime("2026-12-10", 14, 0, "America/Phoenix");
    expect(summer.getUTCHours()).toBe(winter.getUTCHours());
  });
});




// C5: the cheap pass must handle the common shapes so the model is not called.

describe("candidateToInstant", () => {
  it("anchors the wall-clock time in the prospect's zone, not the broker's", () => {
    const candidate = {
      date: "2026-08-20",
      hour: 14,
      minute: 0,
      quote: "thursday at 2",
      method: "pattern" as const,
    };

    const chicago = candidateToInstant(candidate, "America/Chicago");
    const pacific = candidateToInstant(candidate, LA);

    // 2pm Chicago is two hours earlier in absolute terms than 2pm Pacific.
    expect(pacific.getTime() - chicago.getTime()).toBe(2 * 60 * 60 * 1000);
    expect(formatInZone(chicago, "America/Chicago")).toContain("2:00 PM");
  });
});

/*
 * Thread-level detection.
 *
 * The three shapes that decided the design, asserted against the shape of the
 * contract rather than against a live model — the model itself was verified by
 * hand on Gerald's real thread, which returned 5pm.
 */
describe("detectCallInThread contract", () => {
  const source = readFileSync(
    resolve(process.cwd(), "lib/calls/detect.ts"),
    "utf8"
  );

  it("reads the whole exchange, not one message", () => {
    /*
     * The bug this replaced: "When is a good time to call?" / "5pm" has the
     * intent in one message and the time in another, and no single-message
     * gate can see it.
     */
    expect(source).toMatch(/When is a good time to call\?" followed by "5pm"/);
    expect(source).toMatch(/Read the exchange, not the sentence/);
  });

  it("keeps the wants-call answer on the same call", () => {
    // One model call answers both questions; two would be two chances to
    // disagree about the same conversation.
    expect(source).toMatch(/RETURN WANTS_CALL/);
    expect(source).toMatch(/Only when the LEAD wants it/);
  });

  it("is told that finding nothing is the common case", () => {
    // Without this the model reliably invents a call from any date-shaped
    // token — "I get paid on the 15th" was the one that kept surfacing.
    expect(source).toMatch(/RETURN NEITHER/);
    expect(source).toMatch(/Do not manufacture one/);
    expect(source).toMatch(/I get paid on the 15th/);
  });

  it("runs on the cheap tier", () => {
    // Mechanical extraction, high volume, no judgement worth paying for.
    expect(source).toMatch(/role: "extract"/);
  });

  it("no longer carries a single-message gate", () => {
    expect(source).not.toMatch(/looksLikeCommitment/);
    expect(source).not.toMatch(/COMMITMENT_PATTERNS/);
  });
});
