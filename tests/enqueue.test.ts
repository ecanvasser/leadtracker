import { describe, it, expect } from "vitest";
import { sweepRefreshJobs, REFRESH_SWEEP_INTERVAL_MS } from "@/lib/jobs/enqueue";

/**
 * Stub covering the four tables a sweep touches.
 *
 * `inserts` records every enqueue so the tests can assert the cost-critical
 * property: how many jobs a sweep creates, and when it creates none.
 */
function stub(opts: {
  timezone?: string;
  workStart?: string;
  workEnd?: string;
  lastSweepAt?: string | null;
  contacts?: { id: string }[];
  /** Simulates the unique index rejecting an already-outstanding job. */
  duplicateContactIds?: string[];
  claimFails?: boolean;
}) {
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];

  const client = {
    from(table: string) {
      if (table === "user_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  timezone: opts.timezone ?? "America/Los_Angeles",
                  quiet_hours_start: "21:00",
                  quiet_hours_end: "08:00",
                  working_hours_start: opts.workStart ?? "08:00",
                  working_hours_end: opts.workEnd ?? "19:00",
                  last_refresh_sweep_at: opts.lastSweepAt ?? null,
                },
                error: null,
              }),
            }),
          }),
          update(payload: Record<string, unknown>) {
            updates.push(payload);
            return {
              eq: () => ({
                or: async () => ({ error: opts.claimFails ? { message: "lost" } : null }),
              }),
            };
          },
        };
      }
      if (table === "contacts") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  not: async () => ({ data: opts.contacts ?? [], error: null }),
                }),
              }),
            }),
          }),
        };
      }
      // jobs
      return {
        insert: async (payload: Record<string, unknown>) => {
          if ((opts.duplicateContactIds ?? []).includes(payload.contact_id as string)) {
            return { error: { code: "23505" } };
          }
          inserts.push(payload);
          return { error: null };
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { client, inserts, updates };
}

// 2026-08-20 17:00 UTC = 10:00 Pacific — inside working hours.
const DURING_WORK = new Date("2026-08-20T17:00:00Z");
// 2026-08-20 06:00 UTC = 23:00 Pacific the previous day — outside.
const AFTER_HOURS = new Date("2026-08-20T06:00:00Z");

describe("sweepRefreshJobs", () => {
  it("enqueues one refresh job per enrolled hot lead", async () => {
    const { client, inserts } = stub({
      contacts: [{ id: "c1" }, { id: "c2" }, { id: "c3" }],
    });
    const out = await sweepRefreshJobs(client, "u1", DURING_WORK);

    expect(out.swept).toBe(true);
    expect(out.enqueued).toBe(3);
    expect(inserts).toHaveLength(3);
    expect(inserts.every((i) => i.job_type === "refresh_cache")).toBe(true);
  });

  // Gating lives in the worker, not the cron expression: pg_cron runs in the
  // database timezone and would be an hour off for half the year.
  it("enqueues nothing outside working hours", async () => {
    const { client, inserts } = stub({ contacts: [{ id: "c1" }] });
    const out = await sweepRefreshJobs(client, "u1", AFTER_HOURS);

    expect(out.swept).toBe(false);
    expect(out.reason).toContain("working hours");
    expect(inserts).toEqual([]);
  });

  it("respects a working window in a different timezone", async () => {
    // 17:00 UTC is 13:00 in New York — still inside 08:00-19:00.
    const { client } = stub({ timezone: "America/New_York", contacts: [{ id: "c1" }] });
    expect((await sweepRefreshJobs(client, "u1", DURING_WORK)).swept).toBe(true);

    // 17:00 UTC is 02:00 in Tokyo — outside.
    const tokyo = stub({ timezone: "Asia/Tokyo", contacts: [{ id: "c1" }] });
    expect((await sweepRefreshJobs(tokyo.client, "u1", DURING_WORK)).swept).toBe(false);
  });

  it("does not sweep again inside the 15-minute interval", async () => {
    const recent = new Date(DURING_WORK.getTime() - 5 * 60 * 1000).toISOString();
    const { client, inserts } = stub({ lastSweepAt: recent, contacts: [{ id: "c1" }] });
    const out = await sweepRefreshJobs(client, "u1", DURING_WORK);

    expect(out.swept).toBe(false);
    expect(out.reason).toContain("recently");
    expect(inserts).toEqual([]);
  });

  it("sweeps once the interval has elapsed", async () => {
    const old = new Date(
      DURING_WORK.getTime() - REFRESH_SWEEP_INTERVAL_MS - 1000
    ).toISOString();
    const { client, inserts } = stub({ lastSweepAt: old, contacts: [{ id: "c1" }] });

    expect((await sweepRefreshJobs(client, "u1", DURING_WORK)).swept).toBe(true);
    expect(inserts).toHaveLength(1);
  });

  it("claims the interval before enqueueing, so overlapping ticks cannot both run", async () => {
    const { client, updates, inserts } = stub({ contacts: [{ id: "c1" }] });
    await sweepRefreshJobs(client, "u1", DURING_WORK);

    // The watermark is written before any job is created.
    expect(updates).toHaveLength(1);
    expect(updates[0].last_refresh_sweep_at).toBeDefined();
    expect(inserts).toHaveLength(1);
  });

  it("enqueues nothing when another tick won the claim", async () => {
    const { client, inserts } = stub({ contacts: [{ id: "c1" }], claimFails: true });
    const out = await sweepRefreshJobs(client, "u1", DURING_WORK);

    expect(out.swept).toBe(false);
    expect(out.reason).toContain("another tick");
    expect(inserts).toEqual([]);
  });

  it("skips a lead that already has an outstanding refresh", async () => {
    const { client, inserts } = stub({
      contacts: [{ id: "c1" }, { id: "c2" }],
      duplicateContactIds: ["c1"],
    });
    const out = await sweepRefreshJobs(client, "u1", DURING_WORK);

    expect(out.enqueued).toBe(1);
    expect(out.skipped).toBe(1);
    expect(inserts).toHaveLength(1);
  });

  it("handles having no enrolled hot leads", async () => {
    const { client, inserts } = stub({ contacts: [] });
    const out = await sweepRefreshJobs(client, "u1", DURING_WORK);

    expect(out.swept).toBe(true);
    expect(out.enqueued).toBe(0);
    expect(inserts).toEqual([]);
  });

  // The cost model depends on this: ~1,000 Bonzo-only refreshes a day, and a
  // model call only when a watermark actually moves.
  it("creates only refresh_cache jobs, never a drafting job", async () => {
    const { client, inserts } = stub({ contacts: [{ id: "c1" }, { id: "c2" }] });
    await sweepRefreshJobs(client, "u1", DURING_WORK);

    expect(inserts.map((i) => i.job_type)).toEqual(["refresh_cache", "refresh_cache"]);
  });
});

/**
 * The inbound-reply path must respect the card throttle.
 *
 * "Near-real-time" means the reply is first in the queue, not exempt from it.
 * Three replies arriving together produced three simultaneous cards, which is
 * precisely the flood the throttle exists to prevent.
 */
describe("inbound replies respect the one-card throttle", () => {
  it("uses the throttled push, not the bypass", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("lib/jobs/handlers.ts", "utf8")
    );
    const draftReplyBody = src.slice(src.indexOf("export const draftReply"));

    expect(draftReplyBody).toContain("pushNextCard");
    // pushCard bypasses hasOutstandingCard(); draft_reply must not call it.
    expect(draftReplyBody).not.toMatch(/\bawait pushCard\(/);
  });
});
