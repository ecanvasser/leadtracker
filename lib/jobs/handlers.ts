/**
 * Job handlers.
 *
 * Every handler must be idempotent: a worker can be killed between claiming a
 * job and completing it, and the row will be retried. Handlers therefore
 * compare against stored state rather than assuming they are running for the
 * first time.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getCommunicationHistory,
  getProspectNotes,
  getProspect,
  getMortgageFields,
  type BonzoCommunication,
  type BonzoProspect,
} from "@/lib/bonzo/client";
import { analyzeProspect } from "@/lib/insights/analyze";
import type { Job } from "@/lib/jobs/queue";

export interface HandlerResult {
  /** Short line recorded in the drain response for observability. */
  summary: string;
  /** True when this run made at least one model call. */
  usedModel: boolean;
}

export type JobHandler = (
  supabase: SupabaseClient,
  job: Job
) => Promise<HandlerResult>;

/** Newest created_at across a communication list, or null when empty. */
export function newestMessageAt(
  communications: Pick<BonzoCommunication, "created_at">[]
): Date | null {
  let newest: number | null = null;
  for (const c of communications) {
    const t = new Date(c.created_at).getTime();
    if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
  }
  return newest === null ? null : new Date(newest);
}

/**
 * Decides whether a pulled history contains anything newer than the stored
 * watermark.
 *
 * This is the branch that keeps polling cost flat. It is a pure function so
 * the cost guarantee can be tested without touching the network.
 */
export function hasNewMessages(
  communications: Pick<BonzoCommunication, "created_at">[],
  lastMessageAt: string | Date | null | undefined
): boolean {
  const newest = newestMessageAt(communications);
  if (newest === null) return false;
  if (!lastMessageAt) return communications.length > 0;
  const previous = new Date(lastMessageAt).getTime();
  if (!Number.isFinite(previous)) return true;
  return newest.getTime() > previous;
}

/**
 * refresh_cache — re-reads a lead's Bonzo state.
 *
 * Cost rule C1: this runs roughly 1,000 times a day across all hot leads and
 * must never call the model unless the watermark actually moved. The model
 * call sits behind an explicit `if (hasNew)` branch below; tests assert that
 * a refresh finding nothing new makes zero model calls.
 */
export const refreshCache: JobHandler = async (supabase, job) => {
  const contactId = job.contact_id;
  if (!contactId) throw new Error("refresh_cache requires a contact_id");

  const { data: contact, error: contactErr } = await supabase
    .from("contacts")
    .select("id, user_id, bonzo_prospect_id, bonzo_email, insights_enabled, stage")
    .eq("id", contactId)
    .maybeSingle();

  if (contactErr) throw contactErr;
  if (!contact) return { summary: "contact gone", usedModel: false };

  // Enrollment or stage may have changed since the job was enqueued. Not an
  // error — just nothing to do.
  if (!contact.insights_enabled || contact.stage !== "hot_lead") {
    return { summary: "not an enrolled hot lead", usedModel: false };
  }
  if (!contact.bonzo_prospect_id) {
    return { summary: "no linked Bonzo prospect", usedModel: false };
  }

  const { data: cache } = await supabase
    .from("insights_cache")
    .select("ai_analysis, last_message_at, bonzo_prospect_data")
    .eq("contact_id", contactId)
    .maybeSingle();

  // Bonzo API reads only — no model involvement on this path.
  const communications = await getCommunicationHistory(contact.bonzo_prospect_id);
  const newest = newestMessageAt(communications);
  const hasNew = hasNewMessages(communications, cache?.last_message_at);

  if (!hasNew && cache?.ai_analysis) {
    // Nothing changed. Record that we looked and stop before the model.
    await supabase
      .from("insights_cache")
      .update({ last_synced_at: new Date().toISOString() })
      .eq("contact_id", contactId);
    return {
      summary: `no new messages (${communications.length} total)`,
      usedModel: false,
    };
  }

  // Something is genuinely new — only now is a model call justified.
  const [notes, prospect] = await Promise.all([
    getProspectNotes(contact.bonzo_prospect_id),
    getProspect(contact.bonzo_prospect_id),
  ]);

  const resolved = (prospect ??
    (cache?.bonzo_prospect_data as BonzoProspect | undefined) ??
    null) as BonzoProspect | null;

  if (!resolved) {
    throw new Error(
      `Bonzo prospect ${contact.bonzo_prospect_id} could not be read`
    );
  }

  if (getMortgageFields(resolved) === null) {
    console.warn(
      `[jobs/refresh_cache] contact ${contactId} has no mortgage fields; ` +
        `drafts will lack loan context`
    );
  }

  const aiAnalysis = await analyzeProspect(resolved, communications, notes);

  const { error: upsertErr } = await supabase.from("insights_cache").upsert(
    {
      contact_id: contactId,
      user_id: contact.user_id,
      bonzo_prospect_data: resolved,
      bonzo_communication: communications,
      ai_analysis: aiAnalysis,
      generated_at: new Date().toISOString(),
      last_synced_at: new Date().toISOString(),
      last_message_at: newest ? newest.toISOString() : null,
    },
    { onConflict: "contact_id" }
  );
  if (upsertErr) throw upsertErr;

  return {
    summary: `refreshed with ${communications.length} messages`,
    usedModel: true,
  };
};

/**
 * Registry.
 *
 * Types declared in the schema but not yet implemented are absent here on
 * purpose — the worker parks an unknown type as failed with a clear error
 * rather than silently dropping it.
 */
export const handlers: Partial<Record<Job["job_type"], JobHandler>> = {
  refresh_cache: refreshCache,
};
