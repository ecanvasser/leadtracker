import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 6A.6: "A redraft loop is the obvious runaway risk — cap redrafts per lead
 * per day."
 *
 * The cap is checked before the model call, not after, so these tests assert
 * on whether the call happened at all rather than on what came back.
 */

const NOW = new Date("2026-08-23T18:00:00Z");
const TZ = "America/Los_Angeles";

interface StubOptions {
  redraftsToday?: number;
  maxRedrafts?: number;
  mode?: string;
  draft?: string | null;
  status?: string;
}

function stub(opts: StubOptions = {}) {
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];

  const client = {
    from(table: string) {
      const rows =
        table === "outreach_log"
          ? Array.from({ length: opts.redraftsToday ?? 0 }, (_, i) => ({ id: `r${i}` }))
          : [];

      const single =
        table === "user_settings"
          ? {
              drafting_mode: opts.mode ?? "live",
              draft_schedule_hours: [3, 24],
              max_redrafts_per_day: opts.maxRedrafts ?? 3,
              broker_display_name: "Eddie Canvasser",
              broker_company: "E Mortgage Capital",
              timezone: TZ,
            }
          : table === "daily_queue"
            ? {
                id: "q1",
                user_id: "u1",
                contact_id: "c1",
                action_type: "sms",
                draft_message:
                  opts.draft === undefined
                    ? "That credit union quote is worth seeing at 6.5%."
                    : opts.draft,
                status: opts.status ?? "pending",
              }
            : table === "contacts"
              ? {
                  id: "c1",
                  name: "Dana Reyes",
                  stage: "quoted_follow_up",
                  stage_changed_at: "2026-08-23T14:00:00Z",
                }
              : table === "insights_cache"
                ? {
                    lead_state: null,
                    bonzo_communication: [],
                    bonzo_prospect_data: {
                      id: 1,
                      mortgage: { loan_amount: "450,000" },
                    },
                  }
                : null;

      const handler: ProxyHandler<Record<string, unknown>> = {
        get(_t, prop) {
          if (prop === "then") {
            return (resolve: (v: unknown) => unknown) =>
              resolve({ data: rows, error: null });
          }
          if (prop === "maybeSingle" || prop === "single") {
            return async () => ({ data: single, error: null });
          }
          if (prop === "insert") {
            return async (payload: Record<string, unknown>) => {
              inserts.push({ table, ...payload });
              return { error: null };
            };
          }
          if (prop === "update") {
            return (payload: Record<string, unknown>) => {
              updates.push({ table, ...payload });
              return proxy;
            };
          }
          return () => proxy;
        },
      };
      const proxy: Record<string, unknown> = new Proxy({}, handler);
      return proxy;
    },
  } as unknown as SupabaseClient;

  return { client, inserts, updates };
}

function mockDraft() {
  const draftOne = vi.fn(async () => ({
    body: "Send me their quote and I'll put the 6.5% next to it.",
    validated: true,
    violations: [],
    attempts: 1,
    usage: [],
  }));
  vi.doMock("@/lib/ai/draft-one", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/ai/draft-one")>()),
    draftOne,
  }));
  return draftOne;
}

describe("the redraft cap", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("allows a redraft under the cap", async () => {
    const draftOne = mockDraft();
    const { redraftQueueItem } = await import("@/lib/telegram/redraft");
    const { client } = stub({ redraftsToday: 1, maxRedrafts: 3 });

    const out = await redraftQueueItem(client, "u1", "q1", "shorter", NOW);

    expect(out.ok).toBe(true);
    expect(draftOne).toHaveBeenCalledTimes(1);
    expect(out.remaining).toBe(1);
  });

  it("refuses once the cap is reached, without calling the model", async () => {
    const draftOne = mockDraft();
    const { redraftQueueItem } = await import("@/lib/telegram/redraft");
    const { client } = stub({ redraftsToday: 3, maxRedrafts: 3 });

    const out = await redraftQueueItem(client, "u1", "q1", "shorter", NOW);

    expect(out.ok).toBe(false);
    expect(out.refusal).toContain("limit");
    expect(draftOne).not.toHaveBeenCalled();
  });

  it("keeps refusing past the cap rather than resetting", async () => {
    const draftOne = mockDraft();
    const { redraftQueueItem } = await import("@/lib/telegram/redraft");
    const { client } = stub({ redraftsToday: 9, maxRedrafts: 3 });

    expect((await redraftQueueItem(client, "u1", "q1", "shorter", NOW)).ok).toBe(false);
    expect(draftOne).not.toHaveBeenCalled();
  });

  it("points at Edit, which costs nothing, rather than just saying no", async () => {
    mockDraft();
    const { redraftQueueItem } = await import("@/lib/telegram/redraft");
    const { client } = stub({ redraftsToday: 3, maxRedrafts: 3 });

    const out = await redraftQueueItem(client, "u1", "q1", "shorter", NOW);
    expect(out.refusal).toContain("Edit");
  });

  it("a cap of zero turns redrafting off entirely", async () => {
    const draftOne = mockDraft();
    const { redraftQueueItem } = await import("@/lib/telegram/redraft");
    const { client } = stub({ redraftsToday: 0, maxRedrafts: 0 });

    expect((await redraftQueueItem(client, "u1", "q1", "shorter", NOW)).ok).toBe(false);
    expect(draftOne).not.toHaveBeenCalled();
  });

  it("logs the redraft so the next one counts it", async () => {
    mockDraft();
    const { redraftQueueItem } = await import("@/lib/telegram/redraft");
    const { client, inserts } = stub({ redraftsToday: 0 });

    await redraftQueueItem(client, "u1", "q1", "shorter", NOW);

    const logged = inserts.find((i) => i.table === "outreach_log");
    expect(logged?.action_type).toBe("draft_redrafted");
    // 6A.5 — both versions kept, so the diffs are available later.
    expect(logged?.original_draft).toBeTruthy();
    expect(logged?.draft_message).toBeTruthy();
  });
});

describe("what redraft refuses outright", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("will not draft onto a card that has no draft", async () => {
    const draftOne = mockDraft();
    const { redraftQueueItem } = await import("@/lib/telegram/redraft");
    const { client } = stub({ draft: null });

    const out = await redraftQueueItem(client, "u1", "q1", "shorter", NOW);

    // Redraft revises; it does not conjure. Drafting onto a bare follow-up
    // card would be the general-purpose path section 7 rules out.
    expect(out.ok).toBe(false);
    expect(draftOne).not.toHaveBeenCalled();
  });

  it("will not redraft a card that has already been actioned", async () => {
    const draftOne = mockDraft();
    const { redraftQueueItem } = await import("@/lib/telegram/redraft");
    const { client } = stub({ status: "sent" });

    expect((await redraftQueueItem(client, "u1", "q1", "shorter", NOW)).ok).toBe(false);
    expect(draftOne).not.toHaveBeenCalled();
  });

  it("will not redraft while drafting is switched off", async () => {
    const draftOne = mockDraft();
    const { redraftQueueItem } = await import("@/lib/telegram/redraft");
    const { client } = stub({ mode: "off" });

    expect((await redraftQueueItem(client, "u1", "q1", "shorter", NOW)).ok).toBe(false);
    expect(draftOne).not.toHaveBeenCalled();
  });
});
