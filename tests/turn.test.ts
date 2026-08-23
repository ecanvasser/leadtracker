import { describe, it, expect } from "vitest";
import {
  computeTurn,
  groupToday,
  isTodayActive,
  sortByWaiting,
  describeWait,
  DEFAULT_TURN_SETTINGS,
  type TurnCache,
  type TurnContact,
  type TurnInput,
  type TurnResult,
  type TurnVerdict,
} from "@/lib/turn";
import type { LeadState } from "@/lib/insights/lead-state";
import { ALL_STAGES } from "@/types/db";

/** Sunday 23 Aug 2026, 11:00 in Los Angeles. */
const NOW = new Date("2026-08-23T18:00:00Z");
const TZ = "America/Los_Angeles";

const daysAgo = (n: number) =>
  new Date(NOW.getTime() - n * 86_400_000).toISOString();
const hoursAgo = (n: number) =>
  new Date(NOW.getTime() - n * 3_600_000).toISOString();
const inDays = (n: number) =>
  new Date(NOW.getTime() + n * 86_400_000).toISOString();

function contact(over: Partial<TurnContact> = {}): TurnContact {
  return {
    id: "c1",
    name: "Dana Reyes",
    loan_type: "cashout",
    stage: "quoted_follow_up",
    stage_changed_at: daysAgo(3),
    bonzo_prospect_id: 9001,
    insights_enabled: true,
    ...over,
  };
}

function leadState(over: Partial<LeadState> = {}): LeadState {
  return {
    pitch_response: "no_response",
    evidence: null,
    evidence_confidence: "low",
    suggested_angle: "No reply since the quote.",
    last_inbound_at: null,
    last_outbound_at: null,
    days_since_pitch: 3,
    recommended_action: "follow_up",
    suppress_until: null,
    ...over,
  };
}

function cache(over: Partial<TurnCache> = {}): TurnCache {
  return {
    last_inbound_at: null,
    last_outbound_at: null,
    last_message_at: null,
    lead_state: null,
    ...over,
  };
}

function input(over: Partial<TurnInput> = {}): TurnInput {
  return {
    contact: contact(),
    cache: null,
    tasks: [],
    calls: [],
    handoff: null,
    now: NOW,
    timeZone: TZ,
    settings: DEFAULT_TURN_SETTINGS,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The verdict table — section 8, first bullet.
// ---------------------------------------------------------------------------

interface Row {
  name: string;
  input: TurnInput;
  turn: TurnVerdict["turn"];
  section: TurnVerdict["section"];
  reason?: string;
  since?: string | null;
}

const TABLE: Row[] = [
  {
    name: "an unanswered inbound is yours",
    input: input({
      cache: cache({ last_inbound_at: daysAgo(1), last_outbound_at: daysAgo(2) }),
    }),
    turn: "yours",
    section: "your_move",
    since: daysAgo(1),
  },
  {
    name: "needs_quote is yours regardless of history",
    input: input({
      contact: contact({ stage: "needs_quote", stage_changed_at: hoursAgo(2) }),
      // Freshly messaged, which on any other stage would read as their move.
      cache: cache({ last_outbound_at: hoursAgo(1) }),
    }),
    turn: "yours",
    section: "your_move",
    since: hoursAgo(2),
  },
  {
    name: "needs_quote with no history at all is still yours",
    input: input({
      contact: contact({ stage: "needs_quote", stage_changed_at: daysAgo(4), bonzo_prospect_id: null }),
      cache: null,
    }),
    turn: "yours",
    section: "your_move",
    since: daysAgo(4),
  },
  {
    name: "an overdue task makes it yours",
    input: input({
      contact: contact({ stage: "app_in", stage_changed_at: daysAgo(1) }),
      cache: cache({ last_outbound_at: hoursAgo(3) }),
      tasks: [{ id: "t1", title: "Send the appraisal", due_date: "2026-08-20", is_done: false }],
    }),
    turn: "yours",
    section: "your_move",
  },
  {
    name: "a task due today makes it yours",
    input: input({
      contact: contact({ stage: "app_in" }),
      tasks: [{ id: "t1", title: "Chase the CPA letter", due_date: "2026-08-23", is_done: false }],
    }),
    turn: "yours",
    section: "your_move",
  },
  {
    name: "a completed task does not",
    input: input({
      contact: contact({ stage: "app_in" }),
      cache: cache({ last_outbound_at: daysAgo(4) }),
      tasks: [{ id: "t1", title: "Done already", due_date: "2026-08-20", is_done: true }],
    }),
    turn: "theirs",
    section: "their_move",
  },
  {
    name: "a scheduled call is waiting, with the call as its reason",
    input: input({
      cache: cache({ last_inbound_at: daysAgo(1) }),
      calls: [{ scheduled_at: "2026-08-27T21:00:00Z", status: "confirmed" }],
    }),
    turn: "waiting",
    section: "waiting",
    reason: "Call booked Thursday 2pm",
  },
  {
    name: "an unconfirmed call does not hold a lead",
    input: input({
      cache: cache({ last_outbound_at: daysAgo(4) }),
      calls: [{ scheduled_at: "2026-08-27T21:00:00Z", status: "proposed" }],
    }),
    turn: "theirs",
    section: "their_move",
  },
  {
    name: "a call already in the past does not hold a lead",
    input: input({
      cache: cache({ last_outbound_at: daysAgo(4) }),
      calls: [{ scheduled_at: daysAgo(1), status: "confirmed" }],
    }),
    turn: "theirs",
    section: "their_move",
  },
  {
    name: "a snoozed lead is waiting",
    input: input({
      cache: cache({
        last_inbound_at: daysAgo(1),
        lead_state: leadState({ suppress_until: inDays(1) }),
      }),
    }),
    turn: "waiting",
    section: "waiting",
    reason: "Snoozed until tomorrow",
  },
  {
    name: "a snooze that has expired no longer applies",
    input: input({
      cache: cache({
        last_outbound_at: daysAgo(4),
        lead_state: leadState({ suppress_until: daysAgo(1) }),
      }),
    }),
    turn: "theirs",
    section: "their_move",
  },
  {
    name: "silent three days, past the two-day threshold, is theirs",
    input: input({ cache: cache({ last_outbound_at: daysAgo(3) }) }),
    turn: "theirs",
    section: "their_move",
    since: daysAgo(3),
  },
  {
    name: "silent one day is theirs but not yet overdue, so it waits",
    input: input({ cache: cache({ last_outbound_at: daysAgo(1) }) }),
    turn: "theirs",
    section: "waiting",
    reason: "Waiting on them yesterday",
  },
  {
    name: "messaged two hours ago reads as a fresh touch",
    input: input({ cache: cache({ last_outbound_at: hoursAgo(2) }) }),
    turn: "theirs",
    section: "waiting",
    reason: "Messaged them 2 hours ago",
  },
  {
    name: "a handed-off lead names its campaign and the date",
    input: input({
      cache: cache({ last_outbound_at: daysAgo(9) }),
      handoff: { campaign_name: "cold campaign", at: "2026-08-14T17:00:00Z" },
    }),
    turn: "waiting",
    section: "waiting",
    reason: "In cold campaign since Aug 14",
  },
  {
    name: "a reply after a handoff hands it back to Eddie",
    input: input({
      cache: cache({ last_inbound_at: hoursAgo(2), last_outbound_at: daysAgo(9) }),
      handoff: { campaign_name: "cold campaign", at: "2026-08-14T17:00:00Z" },
    }),
    turn: "yours",
    section: "your_move",
  },
  {
    name: "the classifier's hold parks an outbound-last lead",
    input: input({
      cache: cache({
        last_outbound_at: daysAgo(4),
        lead_state: leadState({
          recommended_action: "hold",
          suggested_angle: "She said she'd call after the appraisal.",
        }),
      }),
    }),
    turn: "waiting",
    section: "waiting",
    reason: "On hold — She said she'd call after the appraisal.",
  },
  {
    name: "hold does not outrank an unanswered question",
    input: input({
      cache: cache({
        last_inbound_at: hoursAgo(1),
        last_outbound_at: daysAgo(2),
        lead_state: leadState({ recommended_action: "hold" }),
      }),
    }),
    turn: "yours",
    section: "your_move",
  },
  {
    name: "no cache at all is waiting with a reason that says so",
    input: input({ contact: contact({ stage: "hot_lead" }), cache: null }),
    turn: "waiting",
    section: "waiting",
    reason: "No conversation history yet",
  },
  {
    name: "an unlinked lead says what actually needs fixing",
    input: input({
      contact: contact({ stage: "hot_lead", bonzo_prospect_id: null }),
      cache: null,
    }),
    turn: "waiting",
    section: "waiting",
    reason: "Not linked to Bonzo",
  },
];

describe("computeTurn", () => {
  for (const row of TABLE) {
    it(row.name, () => {
      const verdict = computeTurn(row.input);
      expect(verdict.turn).toBe(row.turn);
      expect(verdict.section).toBe(row.section);
      if (row.reason !== undefined) expect(verdict.reason).toBe(row.reason);
      if (row.since !== undefined) expect(verdict.waiting_since).toBe(row.since);
    });
  }

  it("is pure — the same input twice gives the same verdict", () => {
    const i = input({ cache: cache({ last_outbound_at: daysAgo(3) }) });
    expect(computeTurn(i)).toEqual(computeTurn(i));
  });

  it("honours an overdue threshold raised in settings", () => {
    const i = input({
      cache: cache({ last_outbound_at: daysAgo(3) }),
      settings: { ...DEFAULT_TURN_SETTINGS, overdueDays: 5 },
    });
    expect(computeTurn(i).section).toBe("waiting");
  });
});

// ---------------------------------------------------------------------------
// Section 1.3 — every waiting lead carries a reason.
// ---------------------------------------------------------------------------

describe("waiting reasons", () => {
  it("every row that lands in Waiting has a non-empty reason", () => {
    for (const row of TABLE) {
      const verdict = computeTurn(row.input);
      if (verdict.section !== "waiting") continue;
      expect(verdict.reason, row.name).toBeTruthy();
      expect(verdict.reason!.trim().length, row.name).toBeGreaterThan(0);
    }
  });

  it("holds for every stage, including the terminal ones", () => {
    for (const stage of ALL_STAGES) {
      const verdict = computeTurn(input({ contact: contact({ stage }) }));
      if (verdict.section === "waiting") {
        expect(verdict.reason, stage).toBeTruthy();
      }
    }
  });

  it("keeps adverse and funded off the Today screen", () => {
    expect(isTodayActive("adverse")).toBe(false);
    expect(isTodayActive("funded")).toBe(false);
    expect(isTodayActive("hot_lead")).toBe(true);
    expect(isTodayActive("quoted_follow_up")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Section 2.2 — never "0 days".
// ---------------------------------------------------------------------------

describe("durations", () => {
  it("never renders zero days", () => {
    for (let hours = 0; hours <= 24 * 30; hours += 3) {
      const text = describeWait(hoursAgo(hours), NOW, TZ);
      expect(text).not.toMatch(/\b0 days?\b/);
    }
  });

  it("says today rather than a zero, and omits an unknown entirely", () => {
    expect(describeWait(hoursAgo(2), NOW, TZ)).toBe("today");
    expect(describeWait(null, NOW, TZ)).toBeNull();
    expect(describeWait(daysAgo(1), NOW, TZ)).toBe("yesterday");
    expect(describeWait(daysAgo(3), NOW, TZ)).toBe("3 days");
    expect(describeWait(daysAgo(9), NOW, TZ)).toBe("since Aug 14");
  });

  it("no reason string in the table contains a zero duration", () => {
    for (const row of TABLE) {
      const reason = computeTurn(row.input).reason;
      if (reason) expect(reason, row.name).not.toMatch(/\b0 (days?|hours?|minutes?)\b/);
    }
  });
});

// ---------------------------------------------------------------------------
// Sections 1.2 and 2.1 — ordering, and the counts.
// ---------------------------------------------------------------------------

function result(over: Partial<TurnResult> & { waiting_since: string | null }): TurnResult {
  return {
    turn: "theirs",
    section: "their_move",
    reason: null,
    overdue: true,
    contact: contact(),
    leadState: null,
    ...over,
  };
}

describe("ordering", () => {
  it("puts the longest-waiting lead first", () => {
    const rows = [
      result({ waiting_since: daysAgo(1) }),
      result({ waiting_since: daysAgo(9) }),
      result({ waiting_since: daysAgo(4) }),
    ];
    expect(sortByWaiting(rows).map((r) => r.waiting_since)).toEqual([
      daysAgo(9),
      daysAgo(4),
      daysAgo(1),
    ]);
  });

  it("sorts an unknown wait last, not first", () => {
    const rows = [
      result({ waiting_since: null }),
      result({ waiting_since: daysAgo(2) }),
    ];
    expect(sortByWaiting(rows)[0].waiting_since).toBe(daysAgo(2));
  });
});

describe("the three counts", () => {
  const results: TurnResult[] = TABLE.map((row, i) => ({
    ...computeTurn(row.input),
    contact: { ...row.input.contact, id: `c${i}` },
    leadState: row.input.cache?.lead_state ?? null,
  }));

  it("puts every lead in exactly one section", () => {
    const board = groupToday(results);
    const ids = [
      ...board.your_move.map((r) => r.contact.id),
      ...board.their_move.map((r) => r.contact.id),
      ...board.waiting.map((r) => r.contact.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(results.map((r) => r.contact.id)));
  });

  it("sums the three counts to the total active lead count", () => {
    const board = groupToday(results);
    expect(
      board.counts.your_move + board.counts.their_move + board.counts.waiting
    ).toBe(board.counts.total);
    expect(board.counts.total).toBe(results.length);
  });

  it("reports counts that match the rendered rows", () => {
    const board = groupToday(results);
    expect(board.counts.your_move).toBe(board.your_move.length);
    expect(board.counts.their_move).toBe(board.their_move.length);
    expect(board.counts.waiting).toBe(board.waiting.length);
  });

  it("is empty-safe", () => {
    const board = groupToday([]);
    expect(board.counts).toEqual({ your_move: 0, their_move: 0, waiting: 0, total: 0 });
  });
});
