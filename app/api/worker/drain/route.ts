/**
 * Queue drain endpoint.
 *
 * pg_cron ticks every five minutes and pg_net POSTs here with a bearer token
 * pulled from Vault. The worker lives on Vercel rather than in an Edge
 * Function so it can import the cadence engine, Bonzo client and drafting
 * code directly instead of duplicating them across runtimes.
 *
 * Authentication is a plain shared secret. Deliberately not a JWT: signing
 * one inside Postgres would mean pgjwt (deprecated in PG 17) or pgsodium
 * (Supabase advises against new usage), and a shared secret over TLS is the
 * right amount of machinery for a single-tenant internal endpoint.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  claimJobs,
  completeJob,
  failJob,
  deferJob,
  reapStuckJobs,
  reapTelegramSessions,
  releaseJobs,
  countRunnableJobs,
  type Job,
} from "@/lib/jobs/queue";
import { sweepAllUsers } from "@/lib/jobs/enqueue";
import { handlers } from "@/lib/jobs/handlers";
import { BonzoRateLimitError } from "@/lib/bonzo/client";

/**
 * Jobs per invocation.
 *
 * Bounded so a single request stays well inside serverless limits no matter
 * how many hot leads exist. Throughput comes from chaining (below), not from
 * a bigger batch.
 */
const BATCH_SIZE = 5;

/**
 * How many times one tick may chain into itself.
 *
 * A five-minute tick draining five jobs would only clear 60 jobs an hour,
 * which is short of what ~40 leads refreshing every 15 minutes generate. So
 * when work remains, the worker fires one follow-on request and returns
 * immediately. The cap stops a poisoned queue from chaining forever; the next
 * cron tick picks up whatever is left.
 */
const MAX_CHAIN_DEPTH = 12;

/**
 * Wall-clock budget for one invocation.
 *
 * Deliberately under the 30s pg_net timeout in the cron migration. Overrunning
 * it does not lose the work — the function keeps going — but pg_net records no
 * response, so cron.job_run_details shows a tick with no visible outcome and
 * the queue becomes hard to diagnose from SQL alone. Throughput comes from
 * chaining, not from letting one invocation run long.
 */
const TIME_BUDGET_MS = 25_000;

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/**
 * Constant-time comparison so a timing side channel cannot be used to recover
 * the secret one byte at a time.
 */
function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function POST(request: NextRequest) {
  const expected = process.env.WORKER_SECRET;
  if (!expected) {
    console.error("[worker/drain] WORKER_SECRET is not set; refusing to run");
    return NextResponse.json(
      { error: "Worker is not configured" },
      { status: 503 }
    );
  }

  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !secretsMatch(token, expected)) return unauthorized();

  const body = await request.json().catch(() => ({}));
  const chainDepth = Number(body?.chainDepth ?? 0);

  const supabase = createServiceClient();
  const startedAt = Date.now();

  // Return anything a dead worker left behind before claiming new work.
  let reaped = 0;
  try {
    reaped = await reapStuckJobs(supabase);
  } catch (e) {
    console.error("[worker/drain] reap failed:", e);
  }

  // Housekeeping, not correctness — expired sessions already read as absent.
  try {
    await reapTelegramSessions(supabase);
  } catch (e) {
    console.error("[worker/drain] session reap failed:", e);
  }

  // Decide what is due before claiming. Usually nothing: the tick fires every
  // 5 minutes and leads are swept every 15, inside working hours only.
  let sweeps: Record<string, unknown> = {};
  try {
    sweeps = await sweepAllUsers(supabase);
  } catch (e) {
    console.error("[worker/drain] sweep failed:", e);
  }

  let jobs: Job[];
  try {
    jobs = await claimJobs(supabase, BATCH_SIZE);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[worker/drain] claim failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const results: {
    id: string;
    job_type: string;
    outcome: string;
    detail?: string;
  }[] = [];
  const exhausted: Job[] = [];
  const processed = new Set<string>();

  for (const job of jobs) {
    const handler = handlers[job.job_type];

    if (!handler) {
      // Park rather than drop: an unimplemented type is a deploy problem and
      // should be visible, not silently retried forever.
      await failJob(supabase, { ...job, attempts: 99 }, `No handler for job type '${job.job_type}'`);
      results.push({ id: job.id, job_type: job.job_type, outcome: "no_handler" });
      continue;
    }

    try {
      const result = await handler(supabase, job);
      await completeJob(supabase, job.id);
      results.push({
        id: job.id,
        job_type: job.job_type,
        outcome: "done",
        detail: result.summary,
      });
    } catch (e) {
      // A 429 is not the job's fault. Reschedule without consuming an attempt
      // so a busy minute cannot park otherwise healthy work.
      if (e instanceof BonzoRateLimitError) {
        await deferJob(supabase, job, e.retryAfterMs, e.message);
        results.push({
          id: job.id,
          job_type: job.job_type,
          outcome: "deferred",
          detail: e.message,
        });
        continue;
      }

      const parked = await failJob(supabase, job, e);
      if (parked) exhausted.push(job);
      results.push({
        id: job.id,
        job_type: job.job_type,
        outcome: parked ? "failed" : "retrying",
        detail: e instanceof Error ? e.message : String(e),
      });
    }

    processed.add(job.id);

    if (Date.now() - startedAt > TIME_BUDGET_MS) break;
  }

  // Anything claimed but not reached is released rather than left in
  // 'running'. claimJobs marks the whole batch running up front, so breaking
  // on the time budget would otherwise strand the remainder for the full
  // ten-minute reaper window — and the reaper counts the attempt, so a job
  // that never ran would burn a retry and, for handlers that call the model,
  // pay for the work twice.
  const stranded = jobs.filter((j) => !processed.has(j.id));
  if (stranded.length > 0) {
    try {
      await releaseJobs(supabase, stranded.map((j) => j.id));
    } catch (e) {
      // The reaper is the backstop if this fails.
      console.error("[worker/drain] failed to release stranded jobs:", e);
    }
  }

  // A job that has exhausted its retries must surface rather than fail
  // silently. Import is dynamic so the worker does not pull grammy in when
  // there is nothing to report.
  if (exhausted.length > 0) {
    try {
      const { notifyJobsFailed } = await import("@/lib/jobs/notify");
      await notifyJobsFailed(supabase, exhausted);
    } catch (e) {
      console.error("[worker/drain] could not send failure notification:", e);
    }
  }

  const remaining = await countRunnableJobs(supabase).catch(() => 0);

  // Chain if work remains, so throughput is not capped at BATCH_SIZE per tick.
  let chained = false;
  if (remaining > 0 && chainDepth < MAX_CHAIN_DEPTH) {
    const self = new URL(request.url);
    // Intentionally not awaited: this invocation returns immediately and the
    // follow-on runs as its own bounded request.
    void fetch(self.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${expected}`,
      },
      body: JSON.stringify({ source: "chain", chainDepth: chainDepth + 1 }),
    }).catch((e) => console.error("[worker/drain] chain request failed:", e));
    chained = true;
  }

  return NextResponse.json({
    claimed: jobs.length,
    reaped,
    sweeps,
    released: stranded.length,
    remaining,
    chained,
    chainDepth,
    elapsedMs: Date.now() - startedAt,
    results,
  });
}
