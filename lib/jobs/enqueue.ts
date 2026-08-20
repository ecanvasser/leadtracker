/**
 * Deciding what work is due.
 *
 * Runs at the top of every worker tick. The tick fires every 5 minutes; this
 * decides whether anything should actually be enqueued, which is usually "no".
 *
 * Working-hours gating lives here rather than in the cron expression because
 * pg_cron runs in the database timezone. An hours-based cron would be an hour
 * off for half the year and wrong outright for a second user in another zone.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueueJob } from "@/lib/jobs/queue";
import {
  getNotificationWindows,
  isWithinLocalWindow,
  localDate,
  localMinutesSinceMidnight,
  parseTimeToMinutes,
} from "@/lib/time";

/** Leads are swept at most this often, regardless of tick frequency. */
export const REFRESH_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

export interface SweepResult {
  swept: boolean;
  reason?: string;
  enqueued: number;
  skipped: number;
}

/**
 * Enqueues one refresh_cache job per enrolled hot lead, at most every 15
 * minutes and only inside the broker's working hours.
 *
 * The unique partial index on (user_id, job_type, contact_id) means a lead
 * that already has an outstanding refresh is skipped rather than duplicated,
 * so this is safe to call on every tick.
 */
export async function sweepRefreshJobs(
  supabase: SupabaseClient,
  userId: string,
  now: Date = new Date()
): Promise<SweepResult> {
  const windows = await getNotificationWindows(userId, supabase);

  const working = isWithinLocalWindow(
    windows.workStart,
    windows.workEnd,
    now,
    windows.timeZone
  );
  if (!working) {
    return { swept: false, reason: "outside working hours", enqueued: 0, skipped: 0 };
  }

  const { data: settings } = await supabase
    .from("user_settings")
    .select("last_refresh_sweep_at")
    .eq("user_id", userId)
    .maybeSingle();

  const last = settings?.last_refresh_sweep_at
    ? new Date(settings.last_refresh_sweep_at).getTime()
    : 0;

  if (now.getTime() - last < REFRESH_SWEEP_INTERVAL_MS) {
    return { swept: false, reason: "swept recently", enqueued: 0, skipped: 0 };
  }

  // Claim the interval before enqueueing. Two overlapping ticks would
  // otherwise both pass the check above and both enqueue.
  const { error: claimErr } = await supabase
    .from("user_settings")
    .update({ last_refresh_sweep_at: now.toISOString() })
    .eq("user_id", userId)
    .or(
      settings?.last_refresh_sweep_at
        ? `last_refresh_sweep_at.eq.${settings.last_refresh_sweep_at}`
        : "last_refresh_sweep_at.is.null"
    );

  if (claimErr) {
    return { swept: false, reason: "another tick claimed the sweep", enqueued: 0, skipped: 0 };
  }

  // Hot leads only. The filter is deliberate — insights never extend to
  // App In / Submission / Processing.
  const { data: contacts } = await supabase
    .from("contacts")
    .select("id")
    .eq("user_id", userId)
    .eq("stage", "hot_lead")
    .eq("insights_enabled", true)
    .not("bonzo_prospect_id", "is", null);

  let enqueued = 0;
  let skipped = 0;

  for (const contact of contacts ?? []) {
    const created = await enqueueJob(supabase, {
      userId,
      contactId: contact.id,
      jobType: "refresh_cache",
    });
    if (created) enqueued++;
    else skipped++;
  }

  return { swept: true, enqueued, skipped };
}

/**
 * Enqueues the morning digest once the local clock has passed the configured
 * time and today's digest has not gone out.
 *
 * The due check lives here, alongside the timezone, rather than in a cron
 * expression that would have to guess at the zone.
 */
export async function enqueueDigestIfDue(
  supabase: SupabaseClient,
  userId: string,
  now: Date = new Date()
): Promise<{ enqueued: boolean; reason?: string }> {
  const { data: settings } = await supabase
    .from("user_settings")
    .select("timezone, morning_digest_time, last_digest_date")
    .eq("user_id", userId)
    .maybeSingle();

  if (!settings) return { enqueued: false, reason: "no settings" };

  const timeZone = settings.timezone ?? "America/Los_Angeles";
  const today = localDate(now, timeZone);

  if (settings.last_digest_date === today) {
    return { enqueued: false, reason: "already sent today" };
  }

  const nowMinutes = localMinutesSinceMidnight(now, timeZone);
  const digestMinutes = parseTimeToMinutes(settings.morning_digest_time ?? "08:00");

  if (nowMinutes < digestMinutes) {
    return { enqueued: false, reason: "before digest time" };
  }

  // A tick that first runs long after the digest time still sends it — better
  // a late digest than none. It cannot repeat, because last_digest_date is
  // claimed by the handler before sending.
  const created = await enqueueJob(supabase, { userId, jobType: "morning_digest" });
  return created
    ? { enqueued: true }
    : { enqueued: false, reason: "already queued" };
}

/**
 * Sweeps every linked user.
 *
 * Iterates users rather than assuming one, because the timezone gating already
 * generalises and this is the only other place that assumed a single broker.
 */
export async function sweepAllUsers(
  supabase: SupabaseClient,
  now: Date = new Date()
): Promise<Record<string, SweepResult>> {
  const { data: users } = await supabase.from("user_settings").select("user_id");

  const out: Record<string, SweepResult> = {};
  for (const u of users ?? []) {
    try {
      await enqueueDigestIfDue(supabase, u.user_id, now);
      out[u.user_id] = await sweepRefreshJobs(supabase, u.user_id, now);
    } catch (e) {
      console.error(`[jobs/enqueue] sweep failed for ${u.user_id}:`, e);
      out[u.user_id] = {
        swept: false,
        reason: e instanceof Error ? e.message : "sweep failed",
        enqueued: 0,
        skipped: 0,
      };
    }
  }
  return out;
}
