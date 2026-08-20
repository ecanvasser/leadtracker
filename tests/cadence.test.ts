import { describe, it, expect } from "vitest";
import {
  calculateTodayActions,
  type OutreachLogEntry,
  type BonzoCommEntry,
} from "@/lib/cadence/engine";
import type { Contact } from "@/types/db";

const LA = "America/Los_Angeles";

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: "contact-1",
    user_id: "user-1",
    name: "Dana Reyes",
    loan_type: "purchase",
    crm: "bonzo",
    stage: "hot_lead",
    position: 0,
    adverse_reason: null,
    notes: null,
    bonzo_prospect_id: 5150,
    bonzo_email: "dana@example.com",
    insights_enabled: true,
    created_at: "2026-08-20T16:00:00Z", // 09:00 PDT
    updated_at: "2026-08-20T16:00:00Z",
    ...overrides,
  };
}

function logEntry(overrides: Partial<OutreachLogEntry> = {}): OutreachLogEntry {
  return {
    id: "log-1",
    contact_id: "contact-1",
    action_type: "sms",
    status: "sent",
    created_at: "2026-08-20T17:00:00Z",
    ...overrides,
  };
}

// A Thursday at 09:00 PDT.
const THURSDAY_MORNING = new Date("2026-08-20T16:00:00Z");
// The same Thursday at 17:30 PDT — already Friday in UTC.
const THURSDAY_EVENING = new Date("2026-08-21T00:30:00Z");

describe("lead age", () => {
  it("treats a lead created today as Day 0 and applies speed-to-lead", () => {
    const actions = calculateTodayActions(contact(), [], [], {
      timeZone: LA,
      now: THURSDAY_MORNING,
    });
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0].priorityReason).toContain("Day 1 — speed to lead");
    // Day 0 target is 3 messages + 2 calls.
    expect(actions.filter((a) => a.actionType !== "call")).toHaveLength(3);
    expect(actions.filter((a) => a.actionType === "call")).toHaveLength(2);
  });

  it("gives a day-30 lead far less than a day-0 lead", () => {
    const old = contact({ created_at: "2026-07-21T16:00:00Z" }); // 30 days prior
    const dayThirty = calculateTodayActions(old, [], [], {
      timeZone: LA,
      now: THURSDAY_MORNING,
    });
    const dayZero = calculateTodayActions(contact(), [], [], {
      timeZone: LA,
      now: THURSDAY_MORNING,
    });
    expect(dayThirty.length).toBeLessThan(dayZero.length);
  });

  it("scores a day-0 lead above an older one", () => {
    const dayZero = calculateTodayActions(contact(), [], [], {
      timeZone: LA,
      now: THURSDAY_MORNING,
    });
    const older = calculateTodayActions(
      contact({ created_at: "2026-08-05T16:00:00Z" }),
      [],
      [],
      { timeZone: LA, now: THURSDAY_MORNING }
    );
    if (older.length > 0) {
      expect(dayZero[0].priorityScore).toBeGreaterThan(older[0].priorityScore);
    }
  });
});

describe("local-timezone evaluation", () => {
  // The core 0.2 regression: at 17:30 Pacific the UTC date has already rolled
  // to tomorrow, so a UTC-based engine saw an empty "today" log and re-queued
  // work that was already done.
  it("counts this morning's outreach as today at 5:30 PM Pacific", () => {
    const sentThisMorning = [
      logEntry({ created_at: "2026-08-20T16:30:00Z" }), // 09:30 PDT
      logEntry({ id: "log-2", created_at: "2026-08-20T18:00:00Z" }), // 11:00 PDT
    ];

    const actions = calculateTodayActions(contact(), sentThisMorning, [], {
      timeZone: LA,
      now: THURSDAY_EVENING,
    });

    // Day-0 target is 3 messages; two are already logged today, so exactly one
    // message remains. A UTC engine would have offered all three again.
    expect(actions.filter((a) => a.actionType !== "call")).toHaveLength(1);
  });

  it("does not count yesterday's outreach as today", () => {
    const sentYesterday = [logEntry({ created_at: "2026-08-19T18:00:00Z" })];
    const actions = calculateTodayActions(contact(), sentYesterday, [], {
      timeZone: LA,
      now: THURSDAY_EVENING,
    });
    expect(actions.filter((a) => a.actionType !== "call")).toHaveLength(3);
  });
});

describe("weekend rules", () => {
  // 2026-08-23 is a Sunday. Noon PDT.
  const SUNDAY = new Date("2026-08-23T19:00:00Z");
  // 2026-08-22 is a Saturday. Noon PDT.
  const SATURDAY = new Date("2026-08-22T19:00:00Z");
  // Saturday 17:30 PDT — UTC has already rolled to Sunday.
  const SATURDAY_EVENING = new Date("2026-08-23T00:30:00Z");

  it("returns nothing on a local Sunday by default", () => {
    const actions = calculateTodayActions(contact(), [], [], {
      timeZone: LA,
      now: SUNDAY,
    });
    expect(actions).toEqual([]);
  });

  it("works Sunday when the toggle is on", () => {
    const actions = calculateTodayActions(contact(), [], [], {
      timeZone: LA,
      now: SUNDAY,
      workSunday: true,
    });
    expect(actions.length).toBeGreaterThan(0);
  });

  it("caps Saturday at one message and no calls", () => {
    const actions = calculateTodayActions(contact(), [], [], {
      timeZone: LA,
      now: SATURDAY,
    });
    expect(actions.filter((a) => a.actionType !== "call")).toHaveLength(1);
    expect(actions.filter((a) => a.actionType === "call")).toHaveLength(0);
  });

  it("still treats Saturday evening as Saturday, not Sunday", () => {
    // The regression this guards: UTC says Sunday at 17:30 PDT Saturday, so a
    // UTC engine would blank the queue for the rest of Saturday afternoon.
    const actions = calculateTodayActions(contact(), [], [], {
      timeZone: LA,
      now: SATURDAY_EVENING,
    });
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.filter((a) => a.actionType === "call")).toHaveLength(0);
  });

  it("returns nothing on Saturday when the toggle is off", () => {
    const actions = calculateTodayActions(contact(), [], [], {
      timeZone: LA,
      now: SATURDAY,
      workSaturday: false,
    });
    expect(actions).toEqual([]);
  });

  it("evaluates the weekend in the broker's zone, not the server's", () => {
    // Sunday 09:00 in Los Angeles is Sunday 16:00 UTC — both Sunday, so use an
    // instant where the two disagree: Sunday 20:00 PDT is Monday 03:00 UTC.
    const sundayNight = new Date("2026-08-24T03:00:00Z");
    expect(
      calculateTodayActions(contact(), [], [], { timeZone: LA, now: sundayNight })
    ).toEqual([]);
    // Evaluated in UTC it is Monday, and the engine would have produced work.
    expect(
      calculateTodayActions(contact(), [], [], { timeZone: "UTC", now: sundayNight })
        .length
    ).toBeGreaterThan(0);
  });
});

describe("unanswered reply detection", () => {
  it("outranks everything else when the prospect replied last", () => {
    const comms: BonzoCommEntry[] = [
      {
        id: 1,
        content: "Hey, still interested — what would my payment look like?",
        direction: "inbound",
        type: "sms",
        created_at: "2026-08-20T15:00:00Z",
      },
    ];
    const actions = calculateTodayActions(contact(), [], comms, {
      timeZone: LA,
      now: THURSDAY_MORNING,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0].priorityScore).toBe(1000);
    expect(actions[0].priorityReason).toContain("Unanswered reply");
  });

  it("does not fire when the broker sent the last message", () => {
    const comms: BonzoCommEntry[] = [
      {
        id: 1,
        content: "Following up on your application.",
        direction: "outbound",
        type: "sms",
        created_at: "2026-08-20T15:00:00Z",
      },
    ];
    const actions = calculateTodayActions(contact(), [], comms, {
      timeZone: LA,
      now: THURSDAY_MORNING,
    });
    expect(actions.every((a) => a.priorityScore !== 1000)).toBe(true);
  });
});
