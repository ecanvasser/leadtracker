import { describe, it, expect, vi, beforeEach } from "vitest";
import { CLASSIFY_PROMPT_VERSION } from "@/lib/insights/lead-state";
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
    // doMock registrations survive resetModules, so a mock registered by one
    // test would otherwise apply to every test after it. Only the D1 test
    // mocks the classifier, and an un-stubbed return value crashes the tests
    // that legitimately expect it to run.
    vi.doUnmock("@/lib/insights/lead-state");
  });

  /**
   * Phase 8 D1, proved at the handler rather than the constant.
   *
   * The decision the whole phase rests on: a hands-on lead now DOES get the
   * free Bonzo read, because the Today screen cannot say whose move a Needs
   * Quote lead is without knowing the direction of the last message — and it
   * must still cost nothing. One GET, watermarks written, no classification,
   * no analysis, no workflow evaluation, no spend.
   *
   * Phase 7's version of this test asserted the opposite (not even the free
   * call), which was correct while the sweep only covered one stage. The
   * guarantee that survives is the one about money, not the one about API
   * calls.
   */
  it("reads Bonzo but spends nothing for a lead in a hands-on stage", async () => {
    const analyzeProspect = vi.fn();
    const classifyLeadState = vi.fn();
    const getProspect = vi.fn();
    const getProspectNotes = vi.fn();
    // Brand new messages, in both directions, and no cached analysis — the
    // state every newly-swept lead is in, and the one the old `!hasNew &&
    // cache?.ai_analysis` shape would have sent straight to the classifier.
    const getCommunicationHistory = vi.fn(async () => [
      { created_at: "2026-08-21T10:00:00Z", direction: "outgoing" },
      { created_at: "2026-08-22T10:00:00Z", direction: "incoming" },
    ]);

    vi.doMock("@/lib/insights/analyze", () => ({ analyzeProspect }));
    vi.doMock("@/lib/insights/lead-state", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/insights/lead-state")>()),
      classifyLeadState,
    }));
    vi.doMock("@/lib/bonzo/client", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/bonzo/client")>()),
      getCommunicationHistory,
      getProspect,
      getProspectNotes,
    }));

    const { refreshCache } = await import("@/lib/jobs/handlers");

    const upserts: Record<string, unknown>[] = [];
    const inserts: Record<string, unknown>[] = [];
    const supabase = {
      from(table: string) {
        if (table === "jobs") {
          return {
            insert: async (payload: Record<string, unknown>) => {
              inserts.push(payload);
              return { error: null };
            },
          };
        }
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data:
                  table === "contacts"
                    ? {
                        id: "contact-1",
                        user_id: "user-1",
                        bonzo_prospect_id: 5150,
                        bonzo_email: "d@example.com",
                        insights_enabled: true,
                        stage: "needs_quote",
                      }
                    : // No cache row at all: this lead has never been swept.
                      { data: null, error: null }.data,
                error: null,
              }),
            }),
          }),
          upsert: async (payload: Record<string, unknown>) => {
            upserts.push(payload);
            return { error: null };
          },
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const result = await refreshCache(supabase, {
      ...job(),
      job_type: "refresh_cache",
    });

    // The free half ran.
    expect(getCommunicationHistory).toHaveBeenCalledTimes(1);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].last_inbound_at).toBe("2026-08-22T10:00:00.000Z");
    expect(upserts[0].last_outbound_at).toBe("2026-08-21T10:00:00.000Z");
    expect(upserts[0].last_message_at).toBe("2026-08-22T10:00:00.000Z");

    // The expensive half did not, despite genuinely new messages.
    expect(result.usedModel).toBe(false);
    expect(analyzeProspect).not.toHaveBeenCalled();
    expect(classifyLeadState).not.toHaveBeenCalled();
    expect(getProspect).not.toHaveBeenCalled();
    expect(getProspectNotes).not.toHaveBeenCalled();
    /*
     * One job is enqueued, and only one: the call scan.
     *
     * That is the point of it running here. Call requests arrive while a lead
     * is still hands-on — usually before this app knew the person existed —
     * and gating the scan on stage is what left one call detected across
     * twenty-one leads. It is safe on a cost path because it is pattern-first:
     * a message with no call-shaped wording never reaches a model.
     *
     * The follow-on work that genuinely costs money — draft_reply — is still
     * absent, which is what this test is really guarding.
     */
    expect(inserts.map((i) => i.job_type)).toEqual(["scan_calls"]);
    expect(inserts.map((i) => i.job_type)).not.toContain("draft_reply");
  });

  it("costs nothing at all for a terminal lead — not even the free call", async () => {
    const getCommunicationHistory = vi.fn();
    vi.doMock("@/lib/insights/analyze", () => ({ analyzeProspect: vi.fn() }));
    vi.doMock("@/lib/bonzo/client", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/bonzo/client")>()),
      getCommunicationHistory,
    }));

    const { refreshCache } = await import("@/lib/jobs/handlers");

    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: "contact-1",
                user_id: "user-1",
                bonzo_prospect_id: 5150,
                insights_enabled: true,
                stage: "funded",
              },
              error: null,
            }),
          }),
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const result = await refreshCache(supabase, { ...job(), job_type: "refresh_cache" });
    expect(getCommunicationHistory).not.toHaveBeenCalled();
    expect(result.usedModel).toBe(false);
  });

  it("makes zero model calls when no new messages arrived", async () => {
    const analyzeProspect = vi.fn();
    const getCommunicationHistory = vi.fn(async () => [
      { created_at: "2026-08-20T10:00:00Z" },
    ]);
    const getProspectNotes = vi.fn();
    const getProspect = vi.fn();

    vi.doMock("@/lib/insights/analyze", () => ({ analyzeProspect }));
    vi.doMock("@/lib/bonzo/client", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/bonzo/client")>()),
      getCommunicationHistory,
      getProspectNotes,
      getProspect,
      getMortgageFields: () => ({ loan_amount: "1" }),
    }));

    const { refreshCache } = await import("@/lib/jobs/handlers");

    const upserted: Record<string, unknown>[] = [];
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
                          stage: "quoted_follow_up",
                        },
                        error: null,
                      }
                    : {
                        data: {
                          ai_analysis: { status_read: "cached" },
                          last_message_at: "2026-08-20T10:00:00Z",
                          bonzo_prospect_data: {},
                          /*
                           * The steady state this rule is actually about: a
                           * lead already classified, by the prompt currently
                           * in force. Without these the row reads as never
                           * classified, and a first classification is not the
                           * cost bug C1 exists to catch.
                           */
                          lead_state_at: new Date().toISOString(),
                          lead_state_prompt_version: CLASSIFY_PROMPT_VERSION,
                        },
                        error: null,
                      },
              }),
            };
          },
          update: () => ({ eq: async () => ({ error: null }) }),
          upsert: async (payload: Record<string, unknown>) => {
            upserted.push(payload);
            return { error: null };
          },
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
    // It still records that it looked, so the watermark stays fresh. Written
    // by upsert rather than update since D1: a lead the sweep has only just
    // started covering has no cache row, and an update would write nothing.
    expect(upserted[0]).toHaveProperty("last_synced_at");
  });

  it("does call the model when a new message did arrive", async () => {
    const analyzeProspect = vi.fn(async () => ({
      status_read: "new",
      suggested_next_step: "reply",
      draft_messages: [],
      suggested_todos: [],
    }));

    vi.doMock("@/lib/insights/analyze", () => ({ analyzeProspect }));
    vi.doMock("@/lib/bonzo/client", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/bonzo/client")>()),
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
                          stage: "quoted_follow_up",
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

  it("skips a lead closed out since the job was enqueued, without any API call", async () => {
    const getCommunicationHistory = vi.fn();
    vi.doMock("@/lib/insights/analyze", () => ({ analyzeProspect: vi.fn() }));
    vi.doMock("@/lib/bonzo/client", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/bonzo/client")>()),
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
