/**
 * Job handlers.
 *
 * Every handler must be idempotent: a worker can be killed between claiming a
 * job and completing it, and the row will be retried. Handlers therefore
 * compare against stored state rather than assuming they are running for the
 * first time.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { TERMINAL_STAGES, isQueueEligible, type Contact } from "@/types/db";
import {
  getCommunicationHistory,
  getProspectNotes,
  getProspect,
  getMortgageFields,
  isInbound,
  isOutbound,
  type BonzoCommunication,
  type BonzoProspect,
  messagesOnly,
} from "@/lib/bonzo/client";
import { analyzeProspect } from "@/lib/insights/analyze";
import { draftQuoted } from "@/lib/jobs/draft-quoted";
import type { Job } from "@/lib/jobs/queue";
import { classifyLeadState, shouldClassify, type LeadState } from "@/lib/insights/lead-state";
import { getUserTimezone, localDate, leadAgeDays } from "@/lib/time";
import { enqueueJob } from "@/lib/jobs/queue";
import { scanForCallCommitments, recordProposedCall } from "@/lib/calls/scan";

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
    .select(
      "id, user_id, bonzo_prospect_id, bonzo_email, insights_enabled, stage, created_at, phone, stage_changed_at"
    )
    .eq("id", contactId)
    .maybeSingle();

  if (contactErr) throw contactErr;
  if (!contact) return { summary: "contact gone", usedModel: false };

  if (!contact.bonzo_prospect_id) {
    return { summary: "no linked Bonzo prospect", usedModel: false };
  }

  // Adverse and Funded are off the board, off the Today screen, and not worth
  // a Bonzo call. The sweep already excludes them; this covers a job enqueued
  // before the lead was closed out.
  if ((TERMINAL_STAGES as readonly string[]).includes(contact.stage)) {
    return { summary: `terminal stage (${contact.stage})`, usedModel: false };
  }

  /*
   * D1 widened this job from Quoted – Follow Up to every non-terminal stage,
   * so lib/turn/ can tell whose move a Hot Lead or a Needs Quote lead is.
   * Answering that needs one fact — the direction of the last message — and
   * nothing else.
   *
   * `eligible` is the seam between the two halves of the job. Everything
   * below it up to the watermark write runs for every lead and costs one
   * Bonzo GET. Everything after it — classification, call scanning, reply
   * drafting, workflow evaluation — stays gated on Quoted – Follow Up exactly
   * as before. Phase 8 is meant to add zero AI cost outside the quoted-window
   * drafting, and this line is where that holds.
   */
  const eligible = contact.insights_enabled && isQueueEligible(contact.stage);

  const { data: cache } = await supabase
    .from("insights_cache")
    .select(
      "ai_analysis, last_message_at, last_inbound_at, last_outbound_at, bonzo_prospect_data, lead_state, lead_state_at, calls_scanned_through"
    )
    .eq("contact_id", contactId)
    .maybeSingle();

  // Bonzo API reads only — no model involvement on this path.
  const communications = await getCommunicationHistory(contact.bonzo_prospect_id);
  /*
   * Every watermark below is computed from real messages only. Bonzo's
   * communication feed interleaves audit entries — "Person moved to
   * <campaign> campaign" — which arrive as outgoing, and counting them made a
   * campaign enrolment look like a message to the lead: it moved
   * last_message_at, it made hasNew true, and it reset the silence clock that
   * decides whether a follow-up is owed.
   *
   * The raw list is still what gets cached, because the contact page's
   * conversation view shows those entries and they are useful context there.
   * What must not see them is anything that measures time or writes prose.
   */
  const messages = messagesOnly(communications);
  const newest = newestMessageAt(messages);
  const hasNew = hasNewMessages(messages, cache?.last_message_at);

  // An inbound reply is the highest-value signal in the system. It is tracked
  // separately from last_message_at because an outbound send moves that
  // watermark, and a reply arriving afterwards would otherwise be missed.
  const newestInbound = newestMessageAt(
    messages.filter((c) => isInbound(c.direction))
  );
  const previousInbound = cache?.last_inbound_at
    ? new Date(cache.last_inbound_at).getTime()
    : null;
  const hasNewInbound =
    newestInbound !== null &&
    (previousInbound === null || newestInbound.getTime() > previousInbound);

  // The outbound side, promoted out of lead_state to a column of its own.
  // lead_state is written by the classifier, which stays gated below, so a
  // Needs Quote lead would otherwise have an inbound watermark and no
  // outbound one — and whose-turn is a comparison between the two.
  const newestOutbound = newestMessageAt(
    messages.filter((c) => isOutbound(c.direction))
  );

  const watermarks = {
    last_synced_at: new Date().toISOString(),
    last_message_at: newest ? newest.toISOString() : null,
    last_inbound_at: newestInbound ? newestInbound.toISOString() : null,
    last_outbound_at: newestOutbound ? newestOutbound.toISOString() : null,
  };

  /*
   * Cost rule C1, restated for a sweep that now covers every stage: a poll
   * that finds nothing must make zero model calls.
   *
   * One evaluation, on the shared path, before anything branches. The
   * `!cache?.ai_analysis` term preserves the original behaviour — a lead that
   * has never been analysed is worth a first look even with no new messages —
   * and it is also why the eligibility test has to be part of this expression
   * rather than a separate early return above it. Every newly-swept lead has
   * a null ai_analysis by definition, so a widened sweep that kept the old
   * `!hasNew && cache?.ai_analysis` shape would have sent all of them
   * straight into the classifier on the first tick.
   */
  const needsModelWork = eligible && (hasNew || !cache?.ai_analysis);

  if (!needsModelWork) {
    // Record what we saw and stop before the model. The upsert rather than an
    // update is deliberate: a lead the sweep has only just started covering
    // has no cache row yet, and an update would silently write nothing.
    await supabase.from("insights_cache").upsert(
      {
        contact_id: contactId,
        user_id: contact.user_id,
        bonzo_communication: communications,
        ...watermarks,
      },
      { onConflict: "contact_id" }
    );
    return {
      summary: eligible
        ? `no new messages (${communications.length} total)`
        : `watermarks only (${communications.length} messages, ${contact.stage})`,
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

  // Both model calls sit behind the needsModelWork branch above. A refresh
  // that finds
  // nothing new has already returned without reaching either.
  const timeZone = await getUserTimezone(contact.user_id, supabase);

  /*
   * Spec 3.3. Refreshing Bonzo is free; thinking about it is not. The lead is
   * re-read every 15 minutes so a reply or an opt-out is noticed fast, but the
   * classifier runs twice a day — or immediately when the prospect actually
   * said something, which is the only event that changes what they think.
   */
  const due = shouldClassify({
    hasNewInbound,
    lastClassifiedAt: cache?.lead_state_at as string | null | undefined,
  });

  const [aiAnalysis, classification] = await Promise.all([
    analyzeProspect(resolved, communications, notes),
    !due.classify
      ? Promise.resolve(null)
      : classifyLeadState({
      prospect: resolved,
      communications,
      notes,
      leadAgeDays: leadAgeDays(contact.created_at ?? new Date().toISOString(), timeZone),
      todayLocal: localDate(new Date(), timeZone),
      // When the lead entered Quoted – Follow Up. Drives days_since_pitch,
      // which is computed rather than asked of the model.
      quotedAt: contact.stage_changed_at ?? null,
        }).catch((e) => {
      // Classification is valuable but not worth failing the whole refresh
      // for — the cached history and analysis are still an improvement.
          console.error(
            `[jobs/refresh_cache] classification failed for ${contactId}:`,
            e
          );
          return null;
        }),
  ]);

  if (classification?.evidenceRejected) {
    // Worth seeing: the model read something into the thread it could not
    // evidence, and the rule discarded it back to no_response. A run of these
    // means the prompt needs tuning — and every one of them is a handoff or a
    // "stop chasing" that did not happen on a fabricated quote.
    console.warn(
      `[jobs/refresh_cache] contact ${contactId}: pitch_response discarded, ` +
        `quote not found in history`
    );
  }

  // 3.4 — persist the number. It was previously fetched, displayed once and
  // thrown away, so a reminder had nothing to read off.
  const prospectPhone = (resolved as { phone?: string | null }).phone ?? null;
  if (prospectPhone && prospectPhone !== contact.phone) {
    await supabase
      .from("contacts")
      .update({ phone: prospectPhone })
      .eq("id", contactId);
  }

  const { error: upsertErr } = await supabase.from("insights_cache").upsert(
    {
      contact_id: contactId,
      user_id: contact.user_id,
      bonzo_prospect_data: resolved,
      bonzo_communication: communications,
      // Phase 7 retirement: draft_messages is no longer produced. The key is
      // left off rather than written empty so historical rows keep whatever
      // they already had.
      ai_analysis: aiAnalysis,
      ...(classification
        ? {
            lead_state: classification.state,
            lead_state_at: new Date().toISOString(),
          }
        : {}),
      generated_at: new Date().toISOString(),
      ...watermarks,
      calls_scanned_through: newest ? newest.toISOString() : null,
    },
    { onConflict: "contact_id" }
  );
  if (upsertErr) throw upsertErr;

  // 3.1 — look for a call commitment in the new messages. Pattern-first, so
  // most of these cost nothing; the model is reached only when the wording is
  // genuinely ambiguous.
  let proposedCall: string | null = null;
  try {
    const scan = await scanForCallCommitments({
      userId: contact.user_id,
      contactId,
      prospect: resolved as unknown as Record<string, unknown>,
      communications,
      scannedThrough: cache?.calls_scanned_through ?? null,
      brokerTimezone: timeZone,
      phone: prospectPhone ?? contact.phone ?? null,
    });

    if (scan.proposed) {
      const callId = await recordProposedCall(supabase, {
        userId: contact.user_id,
        contactId,
        scheduledAt: scan.proposed.scheduledAt,
        zone: scan.proposed.zone,
        candidate: scan.proposed.candidate,
      });

      if (callId) {
        proposedCall = callId;
        // Confirmation is a human decision — a misparsed time is worse than
        // no reminder, so this only ever asks.
        const { pushCallConfirmation } = await import("@/lib/telegram/call-confirm");
        await pushCallConfirmation(supabase, contact.user_id, callId).catch(
          (e: unknown) =>
            console.error("[jobs/refresh_cache] call confirmation push failed:", e)
        );
      }
    }
  } catch (e) {
    // Call detection is an enhancement; it must not fail the refresh.
    console.error(`[jobs/refresh_cache] call scan failed for ${contactId}:`, e);
  }

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

  /*
   * Workflow evaluation runs here, on facts that were just refreshed, rather
   * than on its own schedule. Two reasons: the triggers all read facts this
   * job has already gathered, so a separate sweep would re-fetch them; and a
   * lead's situation only changes when this job notices it changing.
   *
   * Failure is swallowed deliberately. A broken workflow must not fail the
   * refresh — the cache, the classification and the reply detection are all
   * still worth having, and reply detection is what shuts a sequence off when
   * someone converts.
   */
  let workflowSummary = "";
  try {
    const { runWorkflowsForContact, buildFacts } = await import("@/lib/workflows/run");
    const facts = buildFacts({
      contact: contact as unknown as Contact,
      prospect: resolved,
      communications,
      leadState: classification?.state ?? (cache?.lead_state as LeadState | null) ?? null,
      leadStateAt: classification ? new Date().toISOString() : (cache?.lead_state_at as string | null) ?? null,
      previousStage: null,
      hasNewInbound,
    });

    const wf = await runWorkflowsForContact({
      supabase,
      userId: contact.user_id,
      contact: contact as unknown as Contact,
      facts,
    });
    if (wf.ran) workflowSummary = `; workflow ${wf.status}: ${wf.summary}`;
  } catch (e) {
    console.error(`[jobs/refresh_cache] workflow evaluation failed for ${contactId}:`, e);
  }

  return {
    summary:
      `refreshed with ${communications.length} messages` +
      (classification
        ? `; ${classification.state.pitch_response}` +
          ` (${classification.state.evidence_confidence})` +
          ` -> ${classification.state.recommended_action}` +
          ` [${due.reason}]`
        : due.classify
          ? "; classification failed"
          : `; not reclassified (${due.reason})`) +
      (hasNewInbound ? "; new inbound reply, queued a response" : "") +
      (proposedCall ? "; proposed a call for confirmation" : "") +
      workflowSummary,
    usedModel: true,
  };
};



/**
 * draft_reply — a prospect replied, so surface them and push the card.
 *
 * Phase 7 retirement: the name is now a misnomer and stays only because it is
 * the job_type value in the queue's check constraint and in pg_cron rows.
 * Nothing is drafted here any more; the job creates a top-priority queue item
 * and pushes it. Renaming it means a migration against live queued jobs, which
 * is Phase 7 work, not retirement work.
 *
 * A reply should still feel near-real-time rather than being batched into
 * tomorrow's queue, which is why it jumps the rank rather than waiting for the
 * morning run.
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
  if (!contact.insights_enabled || !isQueueEligible(contact.stage)) {
    return { summary: "not an enrolled lead in a queue-eligible stage", usedModel: false };
  }

  const timeZone = await getUserTimezone(contact.user_id, supabase);
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
    .filter((c) => isInbound(c.direction))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

  if (!lastInbound) {
    return { summary: "no inbound message to reply to", usedModel: false };
  }

  // Channel mirrors how they reached out. Replying to a text with an email
  // reads as evasion.
  const channel: "sms" | "email" =
    (lastInbound.type ?? "").toLowerCase().includes("email") ? "email" : "sms";

  const { error: insertErr } = await supabase
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
    });

  if (insertErr) throw insertErr;

  // pushNextCard, not pushCard: the throttle still applies. The reply item is
  // rank 0, so it is next in line regardless — but three replies arriving
  // together must not produce three simultaneous cards. That is the flood the
  // throttle exists to prevent, and "near-real-time" means first in the queue,
  // not exempt from it.
  const { pushNextCard } = await import("@/lib/telegram/push");
  const push = await pushNextCard(supabase, contact.user_id);

  return {
    summary:
      `queued a ${channel} reply card for ${contact.name}` +
      (push.pushed ? "; pushed" : `; not pushed (${push.reason})`),
    // No model call left on this path — the classification that matters for a
    // reply runs in refresh_cache, behind the hasNewMessages guard.
    usedModel: false,
  };
};

/**
 * evaluate_workflows — run the rules for one lead, on a real stage change.
 *
 * Exists because refresh_cache cannot do this job. It passes
 * `previousStage: null`, and matchTrigger('stage_changed') declines anything
 * without a previous stage; and its evaluation block sits below the "no new
 * messages" early return, which a stage change never clears — moving a lead
 * in LeadTracker does not create a Bonzo message. The rule could not fire
 * from there for either reason alone.
 *
 * Enqueued by a database trigger on contacts, so it covers every path a stage
 * can change through without any of them having to remember to call it.
 *
 * Reads the previous stage from stage_transitions rather than the job payload.
 * The outstanding-job index coalesces two moves inside one drain window into
 * a single job, and the *latest* transition is the one worth evaluating — a
 * lead now in App In should not have a rule fire about it entering Quoted.
 *
 * Facts come from insights_cache, never from Bonzo. That keeps this free and
 * fast, which is what makes it safe to run on every stage change; the cache is
 * at most one sweep stale, and nothing here reads a value where that matters.
 */
export const evaluateWorkflowsJob: JobHandler = async (supabase, job) => {
  const contactId = job.contact_id;
  if (!contactId) throw new Error("evaluate_workflows requires a contact_id");

  const { data: contact, error: contactErr } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", contactId)
    .maybeSingle();

  if (contactErr) throw contactErr;
  if (!contact) return { summary: "contact gone", usedModel: false };

  const { data: transition } = await supabase
    .from("stage_transitions")
    .select("from_stage, to_stage, changed_at")
    .eq("contact_id", contactId)
    .order("changed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!transition?.from_stage) {
    // A lead's first arrival logs a transition with no from_stage. Nothing
    // stage-based can match that, and the seed tests assert it must not.
    return { summary: "no previous stage to evaluate against", usedModel: false };
  }

  if (transition.to_stage !== contact.stage) {
    // The lead moved again between the trigger firing and this job draining.
    // The transition row is stale; a later job is already queued for the move
    // that actually happened.
    return { summary: "superseded by a later stage change", usedModel: false };
  }

  const { data: cache } = await supabase
    .from("insights_cache")
    .select("bonzo_prospect_data, bonzo_communication, lead_state, lead_state_at")
    .eq("contact_id", contactId)
    .maybeSingle();

  const { runWorkflowsForContact, buildFacts } = await import("@/lib/workflows/run");

  const facts = buildFacts({
    contact: contact as Contact,
    prospect: (cache?.bonzo_prospect_data as BonzoProspect | null) ?? null,
    communications:
      (cache?.bonzo_communication as { direction: string; created_at: string }[] | null) ?? [],
    leadState: (cache?.lead_state as LeadState | null) ?? null,
    leadStateAt: (cache?.lead_state_at as string | null) ?? null,
    previousStage: transition.from_stage,
    // A stage change is not an inbound reply. Triggers that key on one must
    // not see this evaluation as though a message had arrived.
    hasNewInbound: false,
  });

  const wf = await runWorkflowsForContact({
    supabase,
    userId: contact.user_id,
    contact: contact as Contact,
    facts,
  });

  return {
    summary: wf.ran
      ? `${transition.from_stage} -> ${transition.to_stage}; workflow ${wf.status}: ${wf.summary}`
      : `${transition.from_stage} -> ${transition.to_stage}; no rule matched`,
    usedModel: false,
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
  const timeZone = await getUserTimezone(userId, supabase);
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
  draft_quoted: draftQuoted,
  refresh_cache: refreshCache,
  evaluate_workflows: evaluateWorkflowsJob,
  draft_reply: draftReply,
  morning_digest: morningDigest,
};
