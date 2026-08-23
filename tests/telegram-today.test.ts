import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadToday } from "@/lib/turn/load";
import { buildTodayCard } from "@/lib/telegram/today-card";

/** Sunday 23 Aug 2026, 11:00 in Los Angeles. */
const NOW = new Date("2026-08-23T18:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString();

/**
 * A chainable stand-in for the Supabase client.
 *
 * Every builder method returns the same object and the object is awaitable, so
 * it does not matter how long a query's chain is or in what order the filters
 * come — the fixture for that table is what resolves. That keeps the test
 * about the counts rather than about query shape.
 */
function stub(fixtures: Record<string, unknown[]>, single: Record<string, unknown> = {}) {
  const make = (table: string) => {
    const result = { data: fixtures[table] ?? [], error: null };
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown) => resolve(result);
        }
        if (prop === "maybeSingle" || prop === "single") {
          return async () => ({ data: single[table] ?? null, error: null });
        }
        return () => proxy;
      },
    };
    const proxy: Record<string, unknown> = new Proxy({}, handler);
    return proxy;
  };

  return { from: (table: string) => make(table) } as unknown as SupabaseClient;
}

const CONTACTS = [
  // Needs Quote is Eddie's move by definition.
  {
    id: "c1",
    name: "Shawn Cupp",
    loan_type: "cashout",
    stage: "needs_quote",
    stage_changed_at: daysAgo(2),
    bonzo_prospect_id: 101,
    insights_enabled: true,
  },
  // An unanswered inbound.
  {
    id: "c2",
    name: "Lisa Wallace",
    loan_type: "heloan",
    stage: "quoted_follow_up",
    stage_changed_at: daysAgo(4),
    bonzo_prospect_id: 102,
    insights_enabled: true,
  },
  // Silent four days, past the two-day threshold.
  {
    id: "c3",
    name: "Jennifer Biskie",
    loan_type: "purchase",
    stage: "app_in",
    stage_changed_at: daysAgo(9),
    bonzo_prospect_id: 103,
    insights_enabled: true,
  },
  // Messaged an hour ago — theirs, but nowhere near overdue.
  {
    id: "c4",
    name: "Tom Older",
    loan_type: "hei",
    stage: "quoted_follow_up",
    stage_changed_at: daysAgo(1),
    bonzo_prospect_id: 104,
    insights_enabled: true,
  },
  // No thread at all.
  {
    id: "c5",
    name: "Jamila Hymon",
    loan_type: "heloc",
    stage: "hot_lead",
    stage_changed_at: daysAgo(3),
    bonzo_prospect_id: null,
    insights_enabled: false,
  },
];

const CACHE = [
  { contact_id: "c1", last_inbound_at: null, last_outbound_at: daysAgo(1), last_message_at: daysAgo(1), lead_state: null },
  { contact_id: "c2", last_inbound_at: hoursAgo(3), last_outbound_at: daysAgo(2), last_message_at: hoursAgo(3), lead_state: null },
  {
    contact_id: "c3",
    last_inbound_at: null,
    last_outbound_at: daysAgo(4),
    last_message_at: daysAgo(4),
    lead_state: {
      pitch_response: "no_response",
      evidence: null,
      evidence_confidence: "low",
      suggested_angle: "No reply since the quote — try a different channel.",
      last_inbound_at: null,
      last_outbound_at: null,
      days_since_pitch: 4,
      recommended_action: "follow_up",
      suppress_until: null,
    },
  },
  { contact_id: "c4", last_inbound_at: null, last_outbound_at: hoursAgo(1), last_message_at: hoursAgo(1), lead_state: null },
];

function client() {
  return stub(
    {
      contacts: CONTACTS,
      insights_cache: CACHE,
      tasks: [],
      scheduled_calls: [],
      outreach_log: [],
      workflow_runs: [],
    },
    {
      user_settings: {
        timezone: "America/Los_Angeles",
        today_overdue_days: 2,
        today_recent_touch_hours: 4,
      },
    }
  );
}

describe("the Today fixture", () => {
  it("sorts every lead into exactly one section", async () => {
    const board = await loadToday(client(), "u1", NOW);

    expect(board.counts).toEqual({
      your_move: 2, // Needs Quote, plus the unanswered inbound
      their_move: 1, // silent four days
      waiting: 2, // messaged an hour ago, and the one with no thread
      total: 5,
    });

    expect(board.your_move.map((r) => r.contact.name)).toEqual([
      // Oldest first: Shawn entered Needs Quote two days ago, Lisa replied
      // three hours ago.
      "Shawn Cupp",
      "Lisa Wallace",
    ]);
    expect(board.their_move.map((r) => r.contact.name)).toEqual(["Jennifer Biskie"]);

    for (const row of board.waiting) {
      expect(row.reason, row.contact.name).toBeTruthy();
    }
  });
});

/**
 * Section 5.1: "the bot and the web page must both call the same function
 * from lib/turn/. If they can ever disagree, that's a bug."
 */
describe("Telegram /today matches the web page", () => {
  it("returns identical counts for the same fixture", async () => {
    const web = await loadToday(client(), "u1", NOW);
    const card = await buildTodayCard(client(), "u1", NOW);

    expect(card.board.counts).toEqual(web.counts);
  });

  it("prints those counts in the card, not a separately computed set", async () => {
    const card = await buildTodayCard(client(), "u1", NOW);
    const { your_move, their_move, waiting } = card.board.counts;

    expect(card.text).toContain(
      `${your_move} yours · ${their_move} overdue · ${waiting} waiting`
    );
    expect(card.text).toContain("Your move (2)");
    expect(card.text).toContain("Overdue (1)");
  });

  it("orders the rows it shows the same way the page does", async () => {
    const web = await loadToday(client(), "u1", NOW);
    const card = await buildTodayCard(client(), "u1", NOW);

    expect(card.board.your_move.map((r) => r.contact.id)).toEqual(
      web.your_move.map((r) => r.contact.id)
    );
    expect(card.board.their_move.map((r) => r.contact.id)).toEqual(
      web.their_move.map((r) => r.contact.id)
    );
  });

  it("never renders a zero duration", async () => {
    const card = await buildTodayCard(client(), "u1", NOW);
    expect(card.text).not.toMatch(/\b0 (days?|hours?|minutes?)\b/);
  });

  it("carries the angle for a lead that has one", async () => {
    const card = await buildTodayCard(client(), "u1", NOW);
    expect(card.text).toContain("No reply since the quote");
  });

  it("offers actions only for the leads it actually showed", async () => {
    const card = await buildTodayCard(client(), "u1", NOW);
    const data = card.keyboard.inline_keyboard
      .flat()
      .map((b) => ("callback_data" in b ? b.callback_data : ""))
      .filter(Boolean);

    // Three actionable leads on this fixture, each with done + snooze.
    for (const id of ["c1", "c2", "c3"]) {
      expect(data.some((d) => d?.endsWith(`:${id}`)), id).toBe(true);
    }
    // Nothing for the two in Waiting — they are not asking for anything.
    for (const id of ["c4", "c5"]) {
      expect(data.some((d) => d?.endsWith(`:${id}`)), id).toBe(false);
    }
  });

  it("keeps callback_data inside Telegram's 64-byte cap", async () => {
    const card = await buildTodayCard(client(), "u1", NOW);
    for (const button of card.keyboard.inline_keyboard.flat()) {
      if ("callback_data" in button && button.callback_data) {
        expect(
          Buffer.byteLength(button.callback_data, "utf8"),
          button.callback_data
        ).toBeLessThanOrEqual(64);
      }
    }
  });

  it("says you're caught up rather than showing empty sections", async () => {
    const quiet = stub(
      {
        contacts: [CONTACTS[4]],
        insights_cache: [],
        tasks: [],
        scheduled_calls: [],
        outreach_log: [],
        workflow_runs: [],
      },
      { user_settings: { timezone: "America/Los_Angeles", today_overdue_days: 2 } }
    );

    const card = await buildTodayCard(quiet, "u1", NOW);
    expect(card.text).toContain("caught up");
    expect(card.text).not.toContain("Your move (0)");
  });
});
