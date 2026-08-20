import { describe, it, expect, vi, beforeEach } from "vitest";
import { backoffMs, MAX_ATTEMPTS, failJob, deferJob, type Job } from "@/lib/jobs/queue";
import { hasNewMessages, newestMessageAt } from "@/lib/jobs/handlers";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    user_id: "user-1",
    contact_id: "contact-1",
    job_type: "refresh_cache",
    payload: {},
    status: "running",
    attempts: 1,
    last_error: null,
    run_after: "2026-08-20T16:00:00Z",
    locked_at: "2026-08-20T16:00:00Z",
    created_at: "2026-08-20T16:00:00Z",
    completed_at: null,
    ...overrides,
  };
}

/** Minimal Supabase stub that records the update payload. */
function supabaseStub() {
  const updates: Record<string, unknown>[] = [];
  const client = {
    from() {
      return {
        update(payload: Record<string, unknown>) {
          updates.push(payload);
          return {
            eq: async () => ({ error: null }),
          };
        },
      };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, updates };
}

describe("backoff", () => {
  it("grows with each attempt", () => {
    expect(backoffMs(1)).toBeLessThan(backoffMs(2));
    expect(backoffMs(2)).toBeLessThan(backoffMs(3));
  });

  it("starts short, because inbound-reply work is latency sensitive", () => {
    expect(backoffMs(1)).toBe(30_000);
  });

  it("stays capped so a retry never outlives the stuck-job reaper", () => {
    expect(backoffMs(10)).toBeLessThanOrEqual(8 * 60_000);
  });

  it("handles a zero or negative attempt count", () => {
    expect(backoffMs(0)).toBeGreaterThan(0);
    expect(backoffMs(-1)).toBeGreaterThan(0);
  });
});

describe("failJob", () => {
  it("reschedules with backoff while attempts remain", async () => {
    const { client, updates } = supabaseStub();
    const parked = await failJob(client, job({ attempts: 1 }), new Error("boom"));

    expect(parked).toBe(false);
    expect(updates[0].status).toBe("pending");
    expect(updates[0].last_error).toBe("boom");
    // Rescheduled into the future rather than vanishing.
    expect(new Date(updates[0].run_after as string).getTime()).toBeGreaterThan(
      Date.now()
    );
  });

  it("parks the job once attempts are exhausted", async () => {
    const { client, updates } = supabaseStub();
    const parked = await failJob(
      client,
      job({ attempts: MAX_ATTEMPTS }),
      new Error("still broken")
    );

    expect(parked).toBe(true);
    expect(updates[0].status).toBe("failed");
    expect(updates[0].last_error).toBe("still broken");
    expect(updates[0].completed_at).toBeTruthy();
  });

  it("never retries a fourth time", async () => {
    const { client, updates } = supabaseStub();
    await failJob(client, job({ attempts: 4 }), new Error("x"));
    expect(updates[0].status).toBe("failed");
  });

  it("always records last_error, since pg_net drops bodies after ~6 hours", async () => {
    const { client, updates } = supabaseStub();
    await failJob(client, job(), new Error("diagnostic detail"));
    expect(updates[0].last_error).toBe("diagnostic detail");
  });

  it("truncates a huge error so one bad response cannot bloat the row", async () => {
    const { client, updates } = supabaseStub();
    await failJob(client, job(), new Error("x".repeat(10_000)));
    expect((updates[0].last_error as string).length).toBeLessThanOrEqual(2000);
  });

  it("stringifies a non-Error throw", async () => {
    const { client, updates } = supabaseStub();
    await failJob(client, job(), "plain string failure");
    expect(updates[0].last_error).toBe("plain string failure");
  });
});

describe("deferJob", () => {
  it("gives back the attempt it was charged, so a 429 costs no retry", async () => {
    const { client, updates } = supabaseStub();
    await deferJob(client, job({ attempts: 2 }), 60_000, "rate limited");

    expect(updates[0].status).toBe("pending");
    expect(updates[0].attempts).toBe(1);
    expect(new Date(updates[0].run_after as string).getTime()).toBeGreaterThan(
      Date.now()
    );
  });

  it("never drives the attempt count below zero", async () => {
    const { client, updates } = supabaseStub();
    await deferJob(client, job({ attempts: 0 }), 1000, "rate limited");
    expect(updates[0].attempts).toBe(0);
  });
});

describe("newestMessageAt", () => {
  it("returns null for an empty history", () => {
    expect(newestMessageAt([])).toBeNull();
  });

  it("finds the newest regardless of input order", () => {
    const newest = newestMessageAt([
      { created_at: "2026-08-18T10:00:00Z" },
      { created_at: "2026-08-20T10:00:00Z" },
      { created_at: "2026-08-19T10:00:00Z" },
    ]);
    expect(newest?.toISOString()).toBe("2026-08-20T10:00:00.000Z");
  });

  it("ignores unparseable timestamps", () => {
    const newest = newestMessageAt([
      { created_at: "not a date" },
      { created_at: "2026-08-20T10:00:00Z" },
    ]);
    expect(newest?.toISOString()).toBe("2026-08-20T10:00:00.000Z");
  });
});

// Cost rule C1. The refresh tick runs ~1,000 times a day; if every poll
// triggered classification, spend would rise roughly 45x.
describe("hasNewMessages — the guard that keeps polling off the model", () => {
  const history = [
    { created_at: "2026-08-19T10:00:00Z" },
    { created_at: "2026-08-20T10:00:00Z" },
  ];

  it("is false when nothing arrived since the watermark", () => {
    expect(hasNewMessages(history, "2026-08-20T10:00:00Z")).toBe(false);
  });

  it("is false when the watermark is ahead of everything pulled", () => {
    expect(hasNewMessages(history, "2026-08-21T10:00:00Z")).toBe(false);
  });

  it("is true when a genuinely newer message appears", () => {
    expect(hasNewMessages(history, "2026-08-19T12:00:00Z")).toBe(true);
  });

  it("is true on the first sync of a lead that has history", () => {
    expect(hasNewMessages(history, null)).toBe(true);
  });

  it("is false for a lead with no messages at all", () => {
    expect(hasNewMessages([], null)).toBe(false);
    expect(hasNewMessages([], "2026-08-20T10:00:00Z")).toBe(false);
  });

  it("re-syncs rather than stalling when the stored watermark is corrupt", () => {
    expect(hasNewMessages(history, "garbage")).toBe(true);
  });
});

// The spec asks for an explicit assertion that a refresh finding nothing new
// makes zero model calls. This exercises the handler with the network stubbed.
describe("refresh_cache cost guard", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("makes zero model calls when no new messages arrived", async () => {
    const analyzeProspect = vi.fn();
    const getCommunicationHistory = vi.fn(async () => [
      { created_at: "2026-08-20T10:00:00Z" },
    ]);
    const getProspectNotes = vi.fn();
    const getProspect = vi.fn();

    vi.doMock("@/lib/insights/analyze", () => ({ analyzeProspect }));
    vi.doMock("@/lib/bonzo/client", () => ({
      getCommunicationHistory,
      getProspectNotes,
      getProspect,
      getMortgageFields: () => ({ loan_amount: "1" }),
    }));

    const { refreshCache } = await import("@/lib/jobs/handlers");

    const updated: Record<string, unknown>[] = [];
    const supabase = {
      from(table: string) {
        return {
          select() {
            return {
              eq: () => ({
                maybeSingle: async () =>
                  table === "contacts"
                    ? {
                        data: {
                          id: "contact-1",
                          user_id: "user-1",
                          bonzo_prospect_id: 5150,
                          bonzo_email: "d@example.com",
                          insights_enabled: true,
                          stage: "hot_lead",
                        },
                        error: null,
                      }
                    : {
                        data: {
                          ai_analysis: { status_read: "cached" },
                          last_message_at: "2026-08-20T10:00:00Z",
                          bonzo_prospect_data: {},
                        },
                        error: null,
                      },
              }),
            };
          },
          update(payload: Record<string, unknown>) {
            updated.push(payload);
            return { eq: async () => ({ error: null }) };
          },
          upsert: async () => ({ error: null }),
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const result = await refreshCache(supabase, {
      ...job(),
      job_type: "refresh_cache",
    });

    expect(analyzeProspect).not.toHaveBeenCalled();
    expect(getProspectNotes).not.toHaveBeenCalled();
    expect(getProspect).not.toHaveBeenCalled();
    expect(result.usedModel).toBe(false);
    // It still records that it looked, so the watermark stays fresh.
    expect(updated[0]).toHaveProperty("last_synced_at");
  });

  it("does call the model when a new message did arrive", async () => {
    const analyzeProspect = vi.fn(async () => ({
      status_read: "new",
      suggested_next_step: "reply",
      draft_messages: [],
      suggested_todos: [],
    }));

    vi.doMock("@/lib/insights/analyze", () => ({ analyzeProspect }));
    vi.doMock("@/lib/bonzo/client", () => ({
      getCommunicationHistory: async () => [
        { created_at: "2026-08-21T10:00:00Z" },
      ],
      getProspectNotes: async () => [],
      getProspect: async () => ({ id: 5150, mortgage: { loan_amount: "450000" } }),
      getMortgageFields: () => ({ loan_amount: "450000" }),
    }));

    const { refreshCache } = await import("@/lib/jobs/handlers");

    const supabase = {
      from(table: string) {
        return {
          select() {
            return {
              eq: () => ({
                maybeSingle: async () =>
                  table === "contacts"
                    ? {
                        data: {
                          id: "contact-1",
                          user_id: "user-1",
                          bonzo_prospect_id: 5150,
                          bonzo_email: "d@example.com",
                          insights_enabled: true,
                          stage: "hot_lead",
                        },
                        error: null,
                      }
                    : {
                        data: {
                          ai_analysis: { status_read: "cached" },
                          last_message_at: "2026-08-20T10:00:00Z",
                          bonzo_prospect_data: {},
                        },
                        error: null,
                      },
              }),
            };
          },
          update() {
            return { eq: async () => ({ error: null }) };
          },
          upsert: async () => ({ error: null }),
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const result = await refreshCache(supabase, {
      ...job(),
      job_type: "refresh_cache",
    });

    expect(analyzeProspect).toHaveBeenCalledTimes(1);
    expect(result.usedModel).toBe(true);
  });

  it("skips a lead that is no longer an enrolled hot lead, without any API call", async () => {
    const getCommunicationHistory = vi.fn();
    vi.doMock("@/lib/insights/analyze", () => ({ analyzeProspect: vi.fn() }));
    vi.doMock("@/lib/bonzo/client", () => ({
      getCommunicationHistory,
      getProspectNotes: vi.fn(),
      getProspect: vi.fn(),
      getMortgageFields: () => null,
    }));

    const { refreshCache } = await import("@/lib/jobs/handlers");

    const supabase = {
      from() {
        return {
          select() {
            return {
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    id: "contact-1",
                    user_id: "user-1",
                    bonzo_prospect_id: 5150,
                    insights_enabled: false,
                    stage: "adverse",
                  },
                  error: null,
                }),
              }),
            };
          },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const result = await refreshCache(supabase, job());
    expect(getCommunicationHistory).not.toHaveBeenCalled();
    expect(result.usedModel).toBe(false);
  });
});
