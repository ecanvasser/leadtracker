import { describe, it, expect } from "vitest";
import { validateField, validateCadenceConfig } from "@/app/api/settings/route";

/**
 * Settings validation is stricter than most form handling because each of
 * these silently changes behaviour the broker cannot directly observe. A bad
 * timezone does not error — it shifts every date computation in the app.
 */
describe("validateField", () => {
  describe("timezone", () => {
    it("accepts a real IANA zone", () => {
      expect(validateField("timezone", "America/Chicago")).toBeNull();
      expect(validateField("timezone", "Pacific/Honolulu")).toBeNull();
    });

    it("rejects an abbreviation, which Intl does not resolve", () => {
      expect(validateField("timezone", "PST")).toContain("not a valid");
    });

    it("rejects a UTC offset string", () => {
      // An offset is exactly what must not be stored: it is right today and
      // an hour wrong after the next DST transition.
      expect(validateField("timezone", "-08:00")).toContain("not a valid");
    });

    it("rejects a non-string", () => {
      expect(validateField("timezone", 5)).toContain("not a valid");
      expect(validateField("timezone", null)).toContain("not a valid");
    });
  });

  describe("broker identity", () => {
    it("accepts a normal name", () => {
      expect(validateField("broker_display_name", "Eddie Canvasser")).toBeNull();
    });

    it("rejects empty, which would break the opener rule", () => {
      expect(validateField("broker_display_name", "")).toContain("cannot be empty");
      expect(validateField("broker_company", "   ")).toContain("cannot be empty");
    });

    it("rejects something absurdly long", () => {
      expect(validateField("broker_company", "x".repeat(200))).toContain("too long");
    });
  });

  describe("times", () => {
    it("accepts HH:MM and HH:MM:SS", () => {
      expect(validateField("quiet_hours_start", "21:00")).toBeNull();
      expect(validateField("quiet_hours_start", "21:00:00")).toBeNull();
    });

    it("rejects free text", () => {
      expect(validateField("morning_digest_time", "8am")).toContain("must be a time");
      expect(validateField("working_hours_end", "")).toContain("must be a time");
    });
  });

  describe("daily_token_budget", () => {
    it("accepts a sensible budget", () => {
      expect(validateField("daily_token_budget", 2_000_000)).toBeNull();
    });

    it("rejects a budget so low it would look like a broken app", () => {
      expect(validateField("daily_token_budget", 500)).toContain("at least 10,000");
    });

    it("rejects a fraction", () => {
      expect(validateField("daily_token_budget", 1.5)).toContain("whole number");
    });
  });
});

describe("validateCadenceConfig", () => {
  it("accepts a complete config", () => {
    expect(
      validateCadenceConfig({
        work_sunday: false,
        work_saturday: true,
        saturday_max_messages: 1,
        saturday_calls: false,
        unresponsive_max_consecutive: 5,
        blocked_min_days_between_touches: 21,
        in_market_max_age_days: 14,
      })
    ).toBeNull();
  });

  it("accepts a partial config, since fields merge over defaults", () => {
    expect(validateCadenceConfig({ work_sunday: true })).toBeNull();
  });

  it("rejects a non-object", () => {
    expect(validateCadenceConfig("nope")).toContain("must be an object");
    expect(validateCadenceConfig([])).toContain("must be an object");
    expect(validateCadenceConfig(null)).toContain("must be an object");
  });

  it("rejects a boolean field given a string", () => {
    expect(validateCadenceConfig({ work_sunday: "yes" })).toContain("work_sunday");
  });

  it("rejects a negative interval", () => {
    expect(
      validateCadenceConfig({ blocked_min_days_between_touches: -1 })
    ).toContain("whole number");
  });

  it("bounds in_market_max_age_days to something meaningful", () => {
    expect(validateCadenceConfig({ in_market_max_age_days: 0 })).toContain("between");
    expect(validateCadenceConfig({ in_market_max_age_days: 5000 })).toContain("between");
    expect(validateCadenceConfig({ in_market_max_age_days: 14 })).toBeNull();
  });

  it("bounds the unresponsive stop, so a lead cannot be chased forever", () => {
    expect(validateCadenceConfig({ unresponsive_max_consecutive: 0 })).toContain("between");
    expect(validateCadenceConfig({ unresponsive_max_consecutive: 50 })).toContain("between");
  });
});

/*
 * The drafting controls.
 *
 * These shipped as columns with no way to set them — the engine, the schedule
 * and the validator were all built and drafting could only be switched on in
 * the SQL editor. Now that Settings writes them, the route is the last thing
 * standing between a typo and prose going to a client, so each bound is
 * asserted rather than trusted to the database.
 */
describe("drafting settings", () => {
  it("accepts only the three ladder states", () => {
    expect(validateField("drafting_mode", "off")).toBeNull();
    expect(validateField("drafting_mode", "dry_run")).toBeNull();
    expect(validateField("drafting_mode", "live")).toBeNull();
    expect(validateField("drafting_mode", "on")).toBeTruthy();
    expect(validateField("drafting_mode", true)).toBeTruthy();
  });

  it("requires a schedule with at least one reachable slot", () => {
    expect(validateField("draft_schedule_hours", [3, 24])).toBeNull();
    expect(validateField("draft_schedule_hours", [])).toBeTruthy();
    // D5 caps the window at two days and forbids two drafts in one day, so
    // more than four slots cannot all fire. Rejecting beats silently ignoring.
    expect(validateField("draft_schedule_hours", [1, 2, 3, 4, 5])).toBeTruthy();
    expect(validateField("draft_schedule_hours", [3.5])).toBeTruthy();
    expect(validateField("draft_schedule_hours", [-1])).toBeTruthy();
    expect(validateField("draft_schedule_hours", "3, 24")).toBeTruthy();
  });

  it("holds the redraft cap inside the column's own constraint", () => {
    // Matching the check constraint here turns a Postgres violation into a
    // sentence Eddie can read.
    expect(validateField("max_redrafts_per_day", 3)).toBeNull();
    expect(validateField("max_redrafts_per_day", 0)).toBeNull();
    expect(validateField("max_redrafts_per_day", 21)).toBeTruthy();
    expect(validateField("max_redrafts_per_day", -1)).toBeTruthy();
  });

  it("bounds the hold-off window", () => {
    expect(validateField("min_hours_since_last_message", 6)).toBeNull();
    expect(validateField("min_hours_since_last_message", 0)).toBeNull();
    expect(validateField("min_hours_since_last_message", 169)).toBeTruthy();
    expect(validateField("min_hours_since_last_message", 2.5)).toBeTruthy();
  });
});
