import { describe, it, expect } from "vitest";
import {
  calculateTodayActions,
  type OutreachLogEntry,
  type BonzoCommEntry,
} from "@/lib/cadence/engine";
import { DEFAULT_CADENCE_CONFIG } from "@/lib/cadence/config";
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
    phone: null,
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

// Phase 7 retirement: the "lead age" and "local-timezone evaluation" blocks
// went with the in-market lane — both measured its day-0 target of three
// messages, which no longer exists. The local-date regression they also
// guarded is still covered by the weekend block below, which asserts the same
// thing through the Saturday-evening and Sunday-night gates.

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
      config: { ...DEFAULT_CADENCE_CONFIG, work_sunday: true },
    });
    expect(actions.length).toBeGreaterThan(0);
  });

  // Was "caps Saturday at one message and no calls". The cap lived in the
  // in-market lane, so saturday_max_messages and saturday_calls are inert
  // after the Phase 7 retirement. What still holds is the gate: Saturday is a
  // working day by default.
  it("works a local Saturday by default", () => {
    const actions = calculateTodayActions(contact(), [], [], {
      timeZone: LA,
      now: SATURDAY,
    });
    expect(actions.length).toBeGreaterThan(0);
  });

  it("still treats Saturday evening as Saturday, not Sunday", () => {
    // The regression this guards: UTC says Sunday at 17:30 PDT Saturday, so a
    // UTC engine would blank the queue for the rest of Saturday afternoon.
    const actions = calculateTodayActions(contact(), [], [], {
      timeZone: LA,
      now: SATURDAY_EVENING,
    });
    expect(actions.length).toBeGreaterThan(0);
  });

  it("returns nothing on Saturday when the toggle is off", () => {
    const actions = calculateTodayActions(contact(), [], [], {
      timeZone: LA,
      now: SATURDAY,
      config: { ...DEFAULT_CADENCE_CONFIG, work_saturday: false },
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

// ---------------------------------------------------------------------------
// 1.5 Two-lane cadence
// ---------------------------------------------------------------------------

import { planLead, consecutiveUnanswered } from "@/lib/cadence/engine";
import { resolveCadenceConfig } from "@/lib/cadence/config";
import type { LeadState } from "@/lib/insights/lead-state";

function leadState(overrides: Partial<LeadState> = {}): LeadState {
  return {
    lead_temp: "blocked",
    blocker: "credit",
    blocker_evidence: "got denied because of my credit score",
    blocker_confidence: "high",
    unblock_path: "Re-pull once the collection ages off",
    unblock_trigger: "Collection drops off",
    last_inbound_at: null,
    last_outbound_at: null,
    recommended_action: "hold",
    why_now: "Denied on credit in July",
    suppress_until: null,
    ...overrides,
  };
}

describe("blocked lane holds rather than manufacturing a touch", () => {
  const old = contact({ created_at: "2026-06-20T16:00:00Z" }); // ~60 days

  it("holds a blocked lead whose trigger has not fired", () => {
    const plan = planLead(old, [], [], {
      timeZone: LA,
      now: THURSDAY_MORNING,
      leadState: leadState({ recommended_action: "hold" }),
    });
    expect(plan.hold).toBe(true);
    expect(plan.actions).toEqual([]);
    expect(plan.lane).toBe("blocked");
    expect(plan.holdReason).toContain("credit");
  });

  it("holds a blocked lead touched inside the configured interval", () => {
    const recentTouch = [logEntry({ created_at: "2026-08-18T17:00:00Z" })]; // 2 days ago
    const plan = planLead(old, recentTouch, [], {
      timeZone: LA,
      now: THURSDAY_MORNING,
      leadState: leadState({ recommended_action: "email" }),
    });
    expect(plan.hold).toBe(true);
    expect(plan.holdReason).toContain("21");
  });

  it("allows one touch once a meaningful interval has elapsed", () => {
    const oldTouch = [logEntry({ created_at: "2026-07-01T17:00:00Z" })]; // ~50 days
    const plan = planLead(old, oldTouch, [], {
      timeZone: LA,
      now: THURSDAY_MORNING,
      leadState: leadState({ recommended_action: "email" }),
    });
    expect(plan.hold).toBe(false);
    expect(plan.actions).toHaveLength(1);
    // The message must speak to the blocker, not check in.
    expect(plan.actions[0].priorityReason).toContain("credit");
  });

  it("holds a lead suppressed until a future date whatever the lane", () => {
    const future = new Date(Date.now() + 14 * 86_400_000).toISOString();
    const plan = planLead(contact(), [], [], {
      timeZone: LA,
      now: THURSDAY_MORNING,
      leadState: leadState({ lead_temp: "in_market", recommended_action: "sms", suppress_until: future }),
    });
    expect(plan.hold).toBe(true);
    expect(plan.holdReason).toContain("Suppressed");
  });

  it("records why it held, so the decision can be audited", () => {
    const plan = planLead(old, [], [], {
      timeZone: LA,
      now: THURSDAY_MORNING,
      leadState: leadState(),
    });
    expect(plan.inputs.rule).toBe("classifier_hold");
    expect(plan.inputs.lane).toBe("blocked");
    expect(plan.inputs.blocker).toBe("credit");
  });
});

describe("consecutive unanswered counting", () => {
  function unanswered(n: number): BonzoCommEntry[] {
    return Array.from({ length: n }, (_, i) => ({
      id: i,
      content: `Attempt ${i}`,
      direction: "outbound",
      type: "sms",
      created_at: new Date(Date.UTC(2026, 6, 1 + i)).toISOString(),
    }));
  }

  it("counts consecutive unanswered outbound messages", () => {
    expect(consecutiveUnanswered(unanswered(3))).toBe(3);
  });

  it("stops counting at the prospect's last reply", () => {
    const comms: BonzoCommEntry[] = [
      ...unanswered(2),
      { id: 99, content: "still thinking", direction: "inbound", type: "sms", created_at: "2026-07-10T00:00:00Z" },
      { id: 100, content: "no problem", direction: "outbound", type: "sms", created_at: "2026-07-11T00:00:00Z" },
    ];
    expect(consecutiveUnanswered(comms)).toBe(1);
  });

  // Phase 7 retirement: the lane's own tests — the hard stop, channel rotation
  // and the configurable threshold — went with planUnresponsive. The counter
  // stays because it is the primitive the workflow engine's no_inbound_since
  // trigger will read.
});

describe("an unanswered inbound outranks everything else", () => {
  it("acts immediately, at top priority, when a blocked lead replies", () => {
    const comms: BonzoCommEntry[] = [
      { id: 1, content: "Actually my credit just cleared, can we look again?", direction: "inbound", type: "sms", created_at: "2026-08-20T15:00:00Z" },
    ];
    const plan = planLead(contact({ created_at: "2026-06-20T16:00:00Z" }), [], comms, {
      timeZone: LA,
      now: THURSDAY_MORNING,
      leadState: leadState({ lead_temp: "blocked", recommended_action: "hold" }),
    });
    expect(plan.hold).toBe(false);
    expect(plan.inputs.rule).toBe("unanswered_inbound");
    expect(plan.actions[0].priorityScore).toBe(1000);
  });

  // Restores engine-level cover for the UTC-vs-local date bug after the
  // in-market lane's version of this test was retired. tests/time.test.ts
  // guards the localDate() primitive; this guards the one place in the engine
  // still wired to it — todaysLog(), which picks the reply channel.
  //
  // The regression: at 17:30 Pacific the UTC date has already rolled to
  // tomorrow, so a UTC engine sees an empty "today" log, does not know an SMS
  // already went out this morning, and answers the reply by SMS again.
  it("reads today's outreach in local time when picking the reply channel", () => {
    // Thursday 17:30 PDT — Friday 00:30 in UTC.
    const thursdayEvening = new Date("2026-08-21T00:30:00Z");
    const comms: BonzoCommEntry[] = [
      { id: 1, content: "sorry, missed this", direction: "inbound", type: "sms", created_at: "2026-08-20T15:00:00Z" },
    ];
    // Sent 09:30 PDT the same local day.
    const sentThisMorning = [logEntry({ created_at: "2026-08-20T16:30:00Z" })];

    const plan = planLead(contact(), sentThisMorning, comms, {
      timeZone: LA,
      now: thursdayEvening,
    });

    expect(plan.inputs.rule).toBe("unanswered_inbound");
    // Saw this morning's SMS, so it alternates. A UTC engine returns "sms".
    expect(plan.actions[0].actionType).toBe("email");
    expect(plan.inputs.local_date).toBe("2026-08-20");
  });
});

describe("resolveCadenceConfig", () => {
  it("returns defaults for null or garbage", () => {
    expect(resolveCadenceConfig(null).unresponsive_max_consecutive).toBe(5);
    expect(resolveCadenceConfig("nonsense").work_sunday).toBe(false);
  });

  it("merges partial config over defaults", () => {
    const cfg = resolveCadenceConfig({ work_sunday: true });
    expect(cfg.work_sunday).toBe(true);
    expect(cfg.work_saturday).toBe(true);
  });

  it("ignores a field of the wrong type rather than taking the queue down", () => {
    const cfg = resolveCadenceConfig({ unresponsive_max_consecutive: "lots" });
    expect(cfg.unresponsive_max_consecutive).toBe(5);
  });

  it("clamps values that would make the engine nonsensical", () => {
    expect(resolveCadenceConfig({ unresponsive_max_consecutive: 0 }).unresponsive_max_consecutive).toBe(1);
    expect(resolveCadenceConfig({ blocked_min_days_between_touches: -5 }).blocked_min_days_between_touches).toBe(1);
  });
});

// Regression: Bonzo sends "incoming"/"outgoing". Every direction check was
// written against "inbound"/"outbound" and matched nothing, so the score-1000
// unanswered-reply signal never fired against real data. These use Bonzo's
// actual vocabulary rather than the one the code assumed.
describe("direction handling against Bonzo's real vocabulary", () => {
  const opts = { timeZone: LA, now: THURSDAY_MORNING, config: DEFAULT_CADENCE_CONFIG };

  function comm(overrides: Partial<BonzoCommEntry> = {}): BonzoCommEntry {
    return {
      id: 1,
      content: "still interested?",
      direction: "incoming",
      type: "sms",
      created_at: "2026-08-20T13:00:00Z",
      ...overrides,
    };
  }

  it("detects an unanswered reply from an 'incoming' message", () => {
    const actions = calculateTodayActions(
      contact({ created_at: "2026-07-31T16:00:00Z" }),
      [],
      [comm()],
      opts
    );

    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0].priorityScore).toBe(1000);
    expect(actions[0].priorityReason).toMatch(/reply/i);
  });

  it("does not treat an 'outgoing' message as an unanswered reply", () => {
    const actions = calculateTodayActions(
      contact({ created_at: "2026-07-31T16:00:00Z" }),
      [],
      [comm({ direction: "outgoing", content: "checking on docs" })],
      opts
    );

    expect(actions.every((a) => a.priorityScore !== 1000)).toBe(true);
  });

  it("ranks a genuine reply above even a Day 0 lead's cadence", () => {
    const actions = calculateTodayActions(contact(), [], [comm()], opts);
    expect(actions[0].priorityScore).toBe(1000);
  });
});
