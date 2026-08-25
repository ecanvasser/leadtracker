import { describe, it, expect, vi } from "vitest";

/*
 * Cost rule C6.
 *
 * daily_token_budget has been a column since Phase 0 and was never enforced,
 * because nothing recorded what had been spent. Usage was returned by
 * callModel and dropped by every caller except queue generation, so the
 * Settings page reported a fraction of the real number and the budget could
 * not be checked at all.
 */

/** A Supabase stub good enough for the two tables this reads. */
function client(opts: {
  budget?: number;
  timezone?: string;
  rows?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number }[];
  warnedOn?: string | null;
}) {
  const updates: Record<string, unknown>[] = [];
  const inserted: Record<string, unknown>[] = [];

  const api = {
    updates,
    inserted,
    from(table: string) {
      if (table === "user_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  daily_token_budget: opts.budget ?? 1000,
                  timezone: opts.timezone ?? "America/Los_Angeles",
                  last_budget_warning_date: opts.warnedOn ?? null,
                },
              }),
            }),
          }),
          update: (payload: Record<string, unknown>) => {
            updates.push(payload);
            return { eq: () => ({ or: async () => ({ error: null }) }) };
          },
        };
      }
      return {
        select: () => ({
          eq: () => ({
            gte: () => ({ lt: async () => ({ data: opts.rows ?? [] }) }),
          }),
        }),
        insert: async (payload: Record<string, unknown>) => {
          inserted.push(payload);
          return { error: null };
        },
      };
    },
  };
  return api as unknown as Parameters<
    typeof import("@/lib/ai/usage").budgetState
  >[0] & typeof api;
}

describe("budgetState", () => {
  it("counts input, output and cache reads together", async () => {
    const { budgetState } = await import("@/lib/ai/usage");
    const supabase = client({
      budget: 1000,
      rows: [
        { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200 },
        { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
      ],
    });

    const state = await budgetState(supabase, "user-1");
    // Cache reads are cheaper per token, not free. A budget that ignored them
    // would drift furthest exactly where caching is heaviest — the long
    // histories sent on every classification.
    expect(state.used).toBe(365);
    expect(state.remaining).toBe(635);
    expect(state.exceeded).toBe(false);
  });

  it("is exceeded at the budget, not past it", async () => {
    const { budgetState } = await import("@/lib/ai/usage");
    const supabase = client({
      budget: 100,
      rows: [{ input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0 }],
    });
    const state = await budgetState(supabase, "user-1");
    expect(state.exceeded).toBe(true);
    expect(state.remaining).toBe(0);
  });
});

describe("withinBudget", () => {
  it("allows the call when there is room", async () => {
    const { withinBudget } = await import("@/lib/ai/usage");
    const supabase = client({ budget: 1000, rows: [] });
    const out = await withinBudget(supabase, "user-1");
    expect(out.ok).toBe(true);
  });

  it("refuses once the budget is gone", async () => {
    const { withinBudget } = await import("@/lib/ai/usage");
    const supabase = client({
      budget: 10,
      rows: [{ input_tokens: 99, output_tokens: 0, cache_read_input_tokens: 0 }],
      // Already warned today, so this test isolates the refusal from the push.
      warnedOn: new Date().toLocaleDateString("en-CA", {
        timeZone: "America/Los_Angeles",
      }),
    });
    const out = await withinBudget(supabase, "user-1");
    expect(out.ok).toBe(false);
    expect(out.state?.exceeded).toBe(true);
  });

  it("claims the warning date before sending, so a retry cannot send twice", async () => {
    const { withinBudget } = await import("@/lib/ai/usage");
    const supabase = client({
      budget: 10,
      rows: [{ input_tokens: 99, output_tokens: 0, cache_read_input_tokens: 0 }],
      warnedOn: null,
    });
    await withinBudget(supabase, "user-1");
    // The claim is what makes this safe: a budget hit at 9am would otherwise
    // send a Telegram message every five minutes until midnight.
    expect(supabase.updates).toContainEqual(
      expect.objectContaining({ last_budget_warning_date: expect.any(String) })
    );
  });

  it("fails open when the ledger cannot be read", async () => {
    const { withinBudget } = await import("@/lib/ai/usage");
    const broken = {
      from() {
        throw new Error("database is down");
      },
    } as unknown as Parameters<typeof withinBudget>[0];

    // The budget is a cost guard, not a safety interlock. Silently stopping
    // all model work on a transient error is the worse failure.
    const out = await withinBudget(broken, "user-1");
    expect(out.ok).toBe(true);
  });
});

describe("recordModelUsage", () => {
  it("never throws when the ledger write fails", async () => {
    const { recordModelUsage } = await import("@/lib/ai/usage");
    const broken = {
      from: () => ({
        insert: async () => {
          throw new Error("insert failed");
        },
      }),
    } as unknown as Parameters<typeof recordModelUsage>[0];

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    /*
     * The model has already been paid for by the time this runs. Throwing
     * would turn a bookkeeping problem into a lost result, and on a retried
     * job into a second identical charge.
     */
    await expect(
      recordModelUsage(
        broken,
        { userId: "user-1", purpose: "classify" },
        { model: "m", input_tokens: 1, output_tokens: 1, latency_ms: 1 }
      )
    ).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
