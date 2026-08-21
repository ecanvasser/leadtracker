import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { claimAction } from "@/lib/telegram/approval-handlers";
import { claimJobs, releaseJobs } from "@/lib/jobs/queue";

/**
 * Telegram retries webhooks, and the broker can tap a button twice. Both
 * produce a duplicate intent, and the consequence of getting this wrong is a
 * prospect receiving the same message twice.
 *
 * Two layers guard it, covering different failures:
 *   processed_updates  — a redelivered webhook (same update_id)
 *   telegram_actions   — the same intent arriving as two distinct updates,
 *                        which update_id dedupe cannot catch
 */
describe("Telegram callback idempotency", () => {
  /** Stub whose unique index rejects the second identical claim. */
  function stub() {
    const seen = new Set<string>();
    const attempts: string[] = [];

    const client = {
      from() {
        return {
          insert: async (row: Record<string, unknown>) => {
            const key = `${row.queue_item_id}:${row.action}`;
            attempts.push(key);
            if (seen.has(key)) return { error: { code: "23505" } };
            seen.add(key);
            return { error: null };
          },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    return { client, attempts };
  }

  it("claims a first Send", async () => {
    const { client } = stub();
    expect(await claimAction(client, "u1", "q1", "send")).toBe(true);
  });

  // The case that matters: the same card actioned twice.
  it("refuses the second Send on the same card", async () => {
    const { client } = stub();
    expect(await claimAction(client, "u1", "q1", "send")).toBe(true);
    expect(await claimAction(client, "u1", "q1", "send")).toBe(false);
  });

  it("still refuses when the duplicate arrives many times", async () => {
    const { client, attempts } = stub();
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await claimAction(client, "u1", "q1", "send"));
    }
    // Exactly one wins, however many arrive.
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(attempts).toHaveLength(5);
  });

  it("treats a different action on the same card as its own claim", async () => {
    // Send and Skip are distinct decisions; claiming one must not block the
    // other from ever being recorded.
    const { client } = stub();
    expect(await claimAction(client, "u1", "q1", "send")).toBe(true);
    expect(await claimAction(client, "u1", "q1", "skip")).toBe(true);
  });

  it("treats the same action on a different card as its own claim", async () => {
    const { client } = stub();
    expect(await claimAction(client, "u1", "q1", "send")).toBe(true);
    expect(await claimAction(client, "u1", "q2", "send")).toBe(true);
  });

  it("surfaces a real database error rather than silently allowing a resend", async () => {
    // Swallowing this would turn an outage into a duplicate message.
    const client = {
      from: () => ({ insert: async () => ({ error: { code: "42501", message: "denied" } }) }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await expect(claimAction(client, "u1", "q1", "send")).rejects.toMatchObject({
      code: "42501",
    });
  });
});

/**
 * Job claiming.
 *
 * The `for update skip locked` guarantee itself is enforced by Postgres inside
 * claim_jobs(), so it cannot be exercised meaningfully from TypeScript. What
 * can be protected here is the property that makes it apply: the application
 * must claim through that single atomic statement rather than reading rows and
 * updating them separately, which is the shape that would let two overlapping
 * ticks pick up the same job.
 */
describe("job claiming stays atomic", () => {
  it("claims through the claim_jobs RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    const from = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = { rpc, from } as any;

    await claimJobs(client, 5);

    expect(rpc).toHaveBeenCalledWith("claim_jobs", { batch_size: 5 });
    // A select/update pair here would reintroduce the race the RPC exists to
    // close.
    expect(from).not.toHaveBeenCalled();
  });

  it("passes the batch size through, so the bound is honoured", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await claimJobs({ rpc } as any, 3);
    expect(rpc).toHaveBeenCalledWith("claim_jobs", { batch_size: 3 });
  });

  it("raises rather than returning an empty batch when the claim fails", async () => {
    // Returning [] would look like an idle queue and hide the failure.
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(claimJobs({ rpc } as any, 5)).rejects.toMatchObject({ message: "boom" });
  });

  it("releases stranded jobs through the atomic release_jobs RPC", async () => {
    // Status reset and attempt decrement must happen together, or a job the
    // worker never reached burns a retry.
    const rpc = vi.fn().mockResolvedValue({ data: 2, error: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const released = await releaseJobs({ rpc } as any, ["a", "b"]);

    expect(rpc).toHaveBeenCalledWith("release_jobs", { job_ids: ["a", "b"] });
    expect(released).toBe(2);
  });

  it("does not call out at all when there is nothing to release", async () => {
    const rpc = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await releaseJobs({ rpc } as any, [])).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });
});

/**
 * The claim_jobs migration is the only place the concurrency guarantee is
 * actually expressed, so it is asserted directly against the SQL. A rewrite
 * that dropped `skip locked` would otherwise pass every test above while
 * letting two ticks process the same job.
 */
describe("claim_jobs SQL keeps its concurrency guarantee", () => {
  const sql = readFileSync("supabase/migrations/20260820000003_job_queue.sql", "utf8");

  it("claims with for update skip locked", () => {
    expect(sql.toLowerCase()).toContain("for update skip locked");
  });

  it("marks claimed rows running in the same statement", () => {
    const fn = sql.slice(sql.indexOf("create or replace function claim_jobs"));
    expect(fn).toMatch(/update jobs/i);
    expect(fn).toMatch(/status\s*=\s*'running'/i);
  });

  it("only ever claims rows that are due", () => {
    const fn = sql.slice(sql.indexOf("create or replace function claim_jobs"));
    expect(fn).toMatch(/run_after\s*<=\s*now\(\)/i);
    expect(fn).toMatch(/status\s*=\s*'pending'/i);
  });
});
