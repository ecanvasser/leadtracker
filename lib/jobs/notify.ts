/**
 * Surfacing failed jobs.
 *
 * A job that exhausts its retries must reach me rather than dying in a table
 * I never look at. pg_net only keeps response bodies for about six hours, so
 * the detail here comes from jobs.last_error, which the handler side always
 * writes.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createBot } from "@/lib/telegram/bot";
import { getTelegramLink } from "@/lib/db/telegram";
import type { Job } from "@/lib/jobs/queue";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function notifyJobsFailed(
  supabase: SupabaseClient,
  jobs: Job[]
): Promise<void> {
  if (jobs.length === 0) return;

  // Group by user so a future second account gets only its own failures.
  const byUser = new Map<string, Job[]>();
  for (const job of jobs) {
    const list = byUser.get(job.user_id) ?? [];
    list.push(job);
    byUser.set(job.user_id, list);
  }

  for (const [userId, userJobs] of byUser) {
    const link = await getTelegramLink(supabase, userId).catch(() => null);
    if (!link) {
      console.error(
        `[jobs/notify] ${userJobs.length} job(s) failed for user ${userId} but ` +
          `no Telegram account is linked`
      );
      continue;
    }

    // Re-read so the message carries the error the handler recorded.
    const { data: rows } = await supabase
      .from("jobs")
      .select("id, job_type, contact_id, attempts, last_error")
      .in(
        "id",
        userJobs.map((j) => j.id)
      );

    const lines = (rows ?? userJobs).map((j) => {
      const err = (j.last_error ?? "unknown error").slice(0, 180);
      return `• <b>${escapeHtml(j.job_type)}</b>${
        j.contact_id ? ` (lead ${escapeHtml(j.contact_id.slice(0, 8))})` : ""
      }\n  ${escapeHtml(err)}`;
    });

    const text =
      `⚠️ <b>${userJobs.length} background job${userJobs.length === 1 ? "" : "s"} failed</b>\n` +
      `Gave up after ${userJobs[0]?.attempts ?? 3} attempts.\n\n` +
      lines.join("\n");

    try {
      const bot = createBot();
      await bot.api.sendMessage(link.telegram_user_id, text, {
        parse_mode: "HTML",
      });
    } catch (e) {
      console.error("[jobs/notify] Telegram send failed:", e);
    }
  }
}
