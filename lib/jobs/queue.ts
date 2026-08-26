/**
 * Durable job queue.
 *
 * Scheduling lives in Postgres (pg_cron + pg_net); the handlers live here so
 * they can import the cadence engine, the Bonzo client and the drafting code
 * directly rather than being duplicated into an Edge Function runtime.
 *
 * Claiming is atomic via `claim_jobs()` and `for update skip locked`, so two
 * overlapping ticks cannot process the same row. Handlers must still be
 * idempotent: a worker can die between claiming and completing, and the row
 * will be retried.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export const JOB_TYPES = [
  "refresh_cache",
  "generate_queue_item",
  "send_message",
  "classify_lead",
  "draft_reply",
  "extract_call_time",
  "morning_digest",
  // Phase 8 6A. The only job that spends money on prose.
  "draft_quoted",
  /*
   * Evaluates the rules for one lead against facts already in the cache.
   * Enqueued by a database trigger on a genuine stage change, because the
   * stage_changed trigger needs a previous stage and refresh_cache has none
   * to give — it passes null, which that trigger reads as "not a stage-change
   * evaluation" and declines. No Bonzo call, no model call, no cost.
   */
  "evaluate_workflows",
  // Phase 8, contact agents. Drafts one step of a deployed plan.
  "agent_touch",
  // Reads a lead's conversation for a call commitment. Pattern-first.
  "scan_calls",
] as const;

export type JobType = (typeof JOB_TYPES)[number];
export type JobStatus = "pending" | "running" | "done" | "failed";

export interface Job {
  id: string;
  user_id: string;
  contact_id: string | null;
  job_type: JobType;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  last_error: string | null;
  run_after: string;
  locked_at: string | null;
  created_at: string;
  completed_at: string | null;
}

/** Attempts allowed before a job is parked as failed. */
export const MAX_ATTEMPTS = 3;

/**
 * Backoff before a retry. Deliberately short — this queue is latency
 * sensitive: an inbound-reply job that waits an hour to retry has missed the
 * point of the notification.
 */
export function backoffMs(attempts: number): number {
  // 30s, 2m, 8m — quartered growth, capped well under the reap interval.
  return Math.min(8 * 60_000, 30_000 * Math.pow(4, Math.max(0, attempts - 1)));
}

export interface EnqueueOptions {
  userId: string;
  jobType: JobType;
  contactId?: string | null;
  payload?: Record<string, unknown>;
  runAfter?: Date;
}

/**
 * Enqueues a job, ignoring the insert if an equivalent one is already
 * outstanding.
 *
 * The partial unique indexes on `jobs` allow at most one pending-or-running
 * job per (user, type, contact), so a tick that fires while the previous
 * batch is still draining cannot pile up duplicates. A conflict here is the
 * normal case, not an error.
 *
 * Returns true when a row was actually created.
 */
export async function enqueueJob(
  supabase: SupabaseClient,
  opts: EnqueueOptions
): Promise<boolean> {
  const { error } = await supabase.from("jobs").insert({
    user_id: opts.userId,
    contact_id: opts.contactId ?? null,
    job_type: opts.jobType,
    payload: opts.payload ?? {},
    run_after: (opts.runAfter ?? new Date()).toISOString(),
  });

  if (!error) return true;
  // 23505 = unique violation = an equivalent job is already outstanding.
  if (error.code === "23505") return false;
  throw error;
}

/** Claims up to `batchSize` runnable jobs atomically. */
export async function claimJobs(
  supabase: SupabaseClient,
  batchSize: number
): Promise<Job[]> {
  const { data, error } = await supabase.rpc("claim_jobs", {
    batch_size: batchSize,
  });
  if (error) throw error;
  return (data ?? []) as Job[];
}

export async function completeJob(
  supabase: SupabaseClient,
  jobId: string
): Promise<void> {
  const { error } = await supabase
    .from("jobs")
    .update({
      status: "done",
      completed_at: new Date().toISOString(),
      last_error: null,
      locked_at: null,
    })
    .eq("id", jobId);
  if (error) throw error;
}

/**
 * Records a failure and either reschedules with backoff or parks the job.
 *
 * last_error is always written by the handler side, because pg_net only
 * retains response bodies for about six hours — anything needed to diagnose a
 * failure a day later has to live in the row itself.
 *
 * Returns true when the job was parked (exhausted its attempts).
 */
export async function failJob(
  supabase: SupabaseClient,
  job: Job,
  error: unknown
): Promise<boolean> {
  const message = error instanceof Error ? error.message : String(error);
  // Truncated so a huge upstream body cannot bloat the row.
  const lastError = message.slice(0, 2000);
  const exhausted = job.attempts >= MAX_ATTEMPTS;

  const { error: updateErr } = await supabase
    .from("jobs")
    .update(
      exhausted
        ? {
            status: "failed",
            last_error: lastError,
            completed_at: new Date().toISOString(),
            locked_at: null,
          }
        : {
            status: "pending",
            last_error: lastError,
            run_after: new Date(Date.now() + backoffMs(job.attempts)).toISOString(),
            locked_at: null,
          }
    )
    .eq("id", job.id);

  if (updateErr) throw updateErr;
  return exhausted;
}

/**
 * Reschedules a job without consuming an attempt.
 *
 * Used for Bonzo 429s: rate limiting is not the job's fault, and burning a
 * retry on it would park healthy work after three busy minutes.
 */
export async function deferJob(
  supabase: SupabaseClient,
  job: Job,
  retryAfterMs: number,
  reason: string
): Promise<void> {
  const { error } = await supabase
    .from("jobs")
    .update({
      status: "pending",
      attempts: Math.max(0, job.attempts - 1),
      last_error: reason.slice(0, 2000),
      run_after: new Date(Date.now() + retryAfterMs).toISOString(),
      locked_at: null,
    })
    .eq("id", job.id);
  if (error) throw error;
}

/** Returns any stuck 'running' rows to the pool. */
export async function reapStuckJobs(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase.rpc("reap_stuck_jobs", {
    stuck_after: "10 minutes",
  });
  if (error) throw error;
  return (data as number) ?? 0;
}

/**
 * Deletes expired Telegram session rows.
 *
 * Piggybacks on the worker tick rather than getting its own cron schedule —
 * Supabase guidance is to keep concurrent cron jobs in the single digits, and
 * this is a single cheap DELETE that has no reason to be scheduled separately.
 * Expired sessions already read as absent, so this is housekeeping, not
 * correctness.
 */
export async function reapTelegramSessions(
  supabase: SupabaseClient
): Promise<number> {
  const { data, error } = await supabase.rpc("reap_telegram_sessions");
  if (error) throw error;
  return (data as number) ?? 0;
}

export async function countRunnableJobs(
  supabase: SupabaseClient
): Promise<number> {
  const { count, error } = await supabase
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending")
    .lte("run_after", new Date().toISOString());
  if (error) throw error;
  return count ?? 0;
}

/**
 * Returns claimed-but-unprocessed jobs to pending.
 *
 * claim_jobs marks a whole batch running and increments attempts up front.
 * When the worker stops early on its time budget, the remainder never ran and
 * must not be left looking like in-flight work: the stuck-job reaper would
 * count an attempt against them ten minutes later, burning a retry for work
 * that never started and paying twice for any model calls on the rerun.
 *
 * Status reset and attempt decrement happen in one statement — see the
 * release_jobs migration.
 */
export async function releaseJobs(
  supabase: SupabaseClient,
  jobIds: string[]
): Promise<number> {
  if (jobIds.length === 0) return 0;
  const { data, error } = await supabase.rpc("release_jobs", { job_ids: jobIds });
  if (error) throw error;
  return (data as number) ?? 0;
}
