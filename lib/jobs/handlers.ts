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
import { analyzeProspect, type AiAnalysis } from "@/lib/insights/analyze";
import type { Job } from "@/lib/jobs/queue";
import type { BonzoCommEntry } from "@/lib/cadence/engine";
import { classifyLeadState, type LeadState } from "@/lib/insights/lead-state";
import { getUserTimezone, localDate, leadAgeDays } from "@/lib/time";
import { enqueueJob } from "@/lib/jobs/queue";
import { generateDrafts, type PendingAction } from "@/lib/ai/draft";
import { resolveCadenceConfig } from "@/lib/cadence/config";
import { planLead } from "@/lib/cadence/engine";
import type { Contact } from "@/types/db";

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
    .select("id, user_id, bonzo_prospect_id, bonzo_email, insights_enabled, stage, created_at")
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
    .select("ai_analysis, last_message_at, last_inbound_at, bonzo_prospect_data, lead_state")
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

  // Both model calls sit behind the hasNew branch above. A refresh that finds
  // nothing new has already returned without reaching either.
  const timeZone = await getUserTimezone(contact.user_id, supabase);

  const [aiAnalysis, classification] = await Promise.all([
    analyzeProspect(resolved, communications, notes),
    classifyLeadState({
      prospect: resolved,
      communications,
      notes,
      leadAgeDays: leadAgeDays(contact.created_at ?? new Date().toISOString(), timeZone),
      todayLocal: localDate(new Date(), timeZone),
    }).catch((e) => {
      // Classification is valuable but not worth failing the whole refresh
      // for — the cached history and analysis are still an improvement.
      console.error(`[jobs/refresh_cache] classification failed for ${contactId}:`, e);
      return null;
    }),
  ]);

  if (classification?.evidenceRejected) {
    // Worth seeing: the model named a blocker it could not evidence, and the
    // rule discarded it. A run of these means the prompt needs tuning.
    console.warn(
      `[jobs/refresh_cache] contact ${contactId}: blocker discarded, quote not ` +
        `found in history`
    );
  }

  // Drafts for the contact page come from the same path the queue uses, so
  // both surfaces show the same text under the same constraints. Previously
  // analyze.ts produced its own, unvalidated.
  const draftMessages = await draftsForContactPage({
    supabase,
    contact: contact as unknown as Contact,
    communications,
    prospect: resolved,
    leadState: classification?.state ?? null,
    timeZone,
  }).catch((e) => {
    console.error(`[jobs/refresh_cache] drafting failed for ${contactId}:`, e);
    return [] as AiAnalysis["draft_messages"];
  });

  // An inbound reply is the highest-value signal in the system. It is tracked
  // separately from last_message_at because an outbound send moves that
  // watermark, and a reply arriving afterwards would otherwise be missed.
  const newestInbound = newestMessageAt(
    communications.filter((c) => c.direction === "inbound")
  );
  const previousInbound = cache?.last_inbound_at
    ? new Date(cache.last_inbound_at).getTime()
    : null;
  const hasNewInbound =
    newestInbound !== null &&
    (previousInbound === null || newestInbound.getTime() > previousInbound);

  const { error: upsertErr } = await supabase.from("insights_cache").upsert(
    {
      contact_id: contactId,
      user_id: contact.user_id,
      bonzo_prospect_data: resolved,
      bonzo_communication: communications,
      ai_analysis: { ...aiAnalysis, draft_messages: draftMessages },
      ...(classification
        ? {
            lead_state: classification.state,
            lead_state_at: new Date().toISOString(),
          }
        : {}),
      generated_at: new Date().toISOString(),
      last_synced_at: new Date().toISOString(),
      last_message_at: newest ? newest.toISOString() : null,
      last_inbound_at: newestInbound ? newestInbound.toISOString() : null,
    },
    { onConflict: "contact_id" }
  );
  if (upsertErr) throw upsertErr;

  // Follow-on work, enqueued rather than done inline so this handler stays
  // short and the reply path is retried on its own if drafting fails.
  if (hasNewInbound) {
    await enqueueJob(supabase, {
      userId: contact.user_id,
      contactId: contactId,
      jobType: "draft_reply",
      payload: { triggered_by: "inbound_reply" },
    });
  }

  return {
    summary:
      `refreshed with ${communications.length} messages` +
      (classification
        ? `; ${classification.state.lead_temp}/${classification.state.blocker} ` +
          `-> ${classification.state.recommended_action}`
        : "; classification failed") +
      (hasNewInbound ? "; new inbound reply, queued a response" : ""),
    usedModel: true,
  };
};



/**
 * Produces the contact page's suggested messages through the shared drafting
 * path.
 *
 * Runs the cadence engine first so the draft answers a real recommended
 * action rather than a generic "write something". If the engine says hold,
 * there is nothing to draft — and showing nothing is the correct outcome,
 * not a failure.
 */
async function draftsForContactPage(input: {
  supabase: SupabaseClient;
  contact: Contact;
  communications: BonzoCommunication[];
  prospect: BonzoProspect;
  leadState: LeadState | null;
  timeZone: string;
}): Promise<AiAnalysis["draft_messages"]> {
  const { supabase, contact, communications, prospect, leadState, timeZone } = input;

  const { data: settings } = await supabase
    .from("user_settings")
    .select("broker_display_name, broker_company, voice_profile, cadence_config")
    .eq("user_id", contact.user_id)
    .maybeSingle();

  const plan = planLead(contact, [], communications, {
    timeZone,
    config: resolveCadenceConfig(settings?.cadence_config),
    leadState,
  });

  // The engine chose to stay quiet. Respect that here too — manufacturing a
  // draft for the contact page would reintroduce exactly the behaviour the
  // hold rule exists to stop.
  const messageActions = plan.actions.filter((a) => a.actionType !== "call");
  if (messageActions.length === 0) return [];

  const pending: PendingAction[] = messageActions.slice(0, 2).map((action) => ({
    contact,
    action,
    plan,
    cache: {
      contact_id: contact.id,
      bonzo_prospect_data: prospect as unknown as Record<string, unknown>,
      bonzo_communication: communications as unknown as BonzoCommEntry[],
      ai_analysis: {},
      lead_state: leadState,
    },
  }));

  const drafts = await generateDrafts(pending, {
    brokerName: settings?.broker_display_name ?? "Eddie Canvasser",
    brokerCompany: settings?.broker_company ?? "E Mortgage Capital",
    voiceProfile: settings?.voice_profile ?? null,
    timeZone,
  });

  return drafts
    .filter((d) => d.draft_message)
    .map((d) => ({
      channel: d.action_type === "email" ? ("email" as const) : ("sms" as const),
      ...(d.email_subject ? { subject: d.email_subject } : {}),
      body: d.draft_message as string,
    }));
}

/**
 * draft_reply — a prospect replied, so draft a response and push it.
 *
 * This is the flow the whole system is built around. A reply should feel
 * near-real-time rather than being batched into tomorrow's queue, so it
 * creates its own queue item at top priority and pushes the card immediately
 * instead of waiting for the morning run.
 */
export const draftReply: JobHandler = async (supabase, job) => {
  const contactId = job.contact_id;
  if (!contactId) throw new Error("draft_reply requires a contact_id");

  const { data: contact } = await supabase
    .from("contacts")
    .select("id, user_id, name, stage, insights_enabled, bonzo_prospect_id, created_at")
    .eq("id", contactId)
    .maybeSingle();

  if (!contact) return { summary: "contact gone", usedModel: false };
  if (!contact.insights_enabled || contact.stage !== "hot_lead") {
    return { summary: "not an enrolled hot lead", usedModel: false };
  }

  const timeZone = await getUserTimezone(contact.user_id);
  const today = localDate(new Date(), timeZone);

  // Idempotency: a retry must not create a second card for the same reply.
  const { data: existing } = await supabase
    .from("daily_queue")
    .select("id, status")
    .eq("contact_id", contactId)
    .eq("queue_date", today)
    .eq("priority_reason", INBOUND_REPLY_REASON)
    .maybeSingle();

  if (existing) {
    return {
      summary: `reply item already exists (${existing.status})`,
      usedModel: false,
    };
  }

  const { data: cache } = await supabase
    .from("insights_cache")
    .select("lead_state, bonzo_communication, bonzo_prospect_data")
    .eq("contact_id", contactId)
    .maybeSingle();

  const comms = (cache?.bonzo_communication ?? []) as BonzoCommunication[];
  const lastInbound = [...comms]
    .filter((c) => c.direction === "inbound")
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

  if (!lastInbound) {
    return { summary: "no inbound message to reply to", usedModel: false };
  }

  // Channel mirrors how they reached out. Replying to a text with an email
  // reads as evasion.
  const channel: "sms" | "email" =
    (lastInbound.type ?? "").toLowerCase().includes("email") ? "email" : "sms";

  const { data: inserted, error: insertErr } = await supabase
    .from("daily_queue")
    .insert({
      user_id: contact.user_id,
      contact_id: contactId,
      queue_date: today,
      // Above everything else in the day. An unanswered reply outranks any
      // scheduled touch.
      priority_rank: 0,
      priority_reason: INBOUND_REPLY_REASON,
      action_type: channel,
      status: "pending",
      lane: "inbound_reply",
      decision_trace: {
        lane: "inbound_reply",
        rule_fired: "inbound_reply_detected",
        replied_at: lastInbound.created_at,
      },
    })
    .select("id")
    .single();

  if (insertErr) throw insertErr;

  // Draft through the shared path so the reply is held to the same
  // constraints as everything else.
  const { draftSingleQueueItem } = await import("@/lib/ai/draft-one");
  const drafted = await draftSingleQueueItem(supabase, contact.user_id, inserted.id);

  const { pushCard } = await import("@/lib/telegram/push");
  const push = await pushCard(supabase, contact.user_id, inserted.id);

  return {
    summary:
      `drafted a ${channel} reply for ${contact.name}` +
      (drafted.validated ? "" : " (unvalidated)") +
      (push.pushed ? "; pushed" : `; not pushed (${push.reason})`),
    usedModel: true,
  };
};

/**
 * morning_digest — the day's opening summary.
 *
 * Enqueued by the sweep once the local clock passes the configured time. The
 * job is the delivery mechanism only; whether it is due is decided in
 * lib/jobs/enqueue.ts, where the timezone already lives.
 */
export const morningDigest: JobHandler = async (supabase, job) => {
  const userId = job.user_id;
  const timeZone = await getUserTimezone(userId);
  const today = localDate(new Date(), timeZone);

  // Idempotency: a retry after a partial failure must not send a second
  // digest. The date is claimed before sending.
  const { data: settings } = await supabase
    .from("user_settings")
    .select("last_digest_date")
    .eq("user_id", userId)
    .maybeSingle();

  if (settings?.last_digest_date === today) {
    return { summary: "digest already sent today", usedModel: false };
  }

  await supabase
    .from("user_settings")
    .update({ last_digest_date: today })
    .eq("user_id", userId);

  const { sendMorningDigest } = await import("@/lib/telegram/digest");
  const result = await sendMorningDigest(supabase, userId, today);

  return {
    summary: result.sent
      ? `digest sent (${result.total} queued)`
      : `digest not sent: ${result.reason}`,
    usedModel: false,
  };
};

/** Marker used to find an existing reply item on retry. */
export const INBOUND_REPLY_REASON = "They replied — respond";

/**
 * Registry.
 *
 * Types declared in the schema but not yet implemented are absent here on
 * purpose — the worker parks an unknown type as failed with a clear error
 * rather than silently dropping it.
 */
export const handlers: Partial<Record<Job["job_type"], JobHandler>> = {
  refresh_cache: refreshCache,
  draft_reply: draftReply,
  morning_digest: morningDigest,
};
