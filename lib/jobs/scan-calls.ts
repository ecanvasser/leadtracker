/**
 * scan_calls — read a lead's conversation looking for a call commitment.
 *
 * Split out of refresh_cache, where the only call scan used to live. That one
 * sits inside the model-work branch, which is gated on the lead being in
 * Quoted – Follow Up, so it never ran for the leads that actually book calls:
 * Eddie's arrive as "call me at noon tomorrow" while the lead is still a Hot
 * Lead, often before the lead exists in this app at all.
 *
 * Enqueued on two occasions:
 *   - when a lead is linked to Bonzo, with the watermark left null so the
 *     entire history is read. This is the case that matters — the request was
 *     made before the app knew the person existed.
 *   - on any refresh that finds new messages, for every active stage.
 *
 * Cheap by construction. scanForCallCommitments is pattern-first and only
 * reaches a model when the wording is genuinely ambiguous, so a history with
 * nothing call-shaped in it costs nothing at all.
 */

import { recordProposedCall, scanForCallCommitments } from "@/lib/calls/scan";
import { recordModelUsage, withinBudget } from "@/lib/ai/usage";
import {
  getCommunicationHistory,
  getProspect,
  messagesOnly,
  type BonzoProspect,
} from "@/lib/bonzo/client";
import type { JobHandler } from "@/lib/jobs/handlers";
import { getUserTimezone } from "@/lib/time";
import { TERMINAL_STAGES } from "@/types/db";

export const scanCalls: JobHandler = async (supabase, job) => {
  const contactId = job.contact_id;
  if (!contactId) throw new Error("scan_calls requires a contact_id");

  const { data: contact } = await supabase
    .from("contacts")
    .select("id, user_id, name, stage, phone, bonzo_prospect_id")
    .eq("id", contactId)
    .maybeSingle();

  if (!contact) return { summary: "contact gone", usedModel: false };
  if (!contact.bonzo_prospect_id) {
    return { summary: "no linked Bonzo prospect", usedModel: false };
  }

  /*
   * Every active stage, not just the queue-eligible one. A call request is a
   * fact about a conversation and has nothing to do with where the lead sits
   * in the pipeline — gating it on stage is what hid this for six phases.
   * Terminal stages are excluded because a funded or dead lead is not booking
   * anything.
   */
  if ((TERMINAL_STAGES as readonly string[]).includes(contact.stage)) {
    return { summary: `stage is ${contact.stage}; nothing to scan`, usedModel: false };
  }

  const { data: cache } = await supabase
    .from("insights_cache")
    .select("calls_scanned_through, bonzo_prospect_data")
    .eq("contact_id", contactId)
    .maybeSingle();

  const [communications, prospect] = await Promise.all([
    getCommunicationHistory(contact.bonzo_prospect_id),
    getProspect(contact.bonzo_prospect_id),
  ]);

  // Audit entries are not messages and cannot contain a call commitment.
  // "Person moved to campaign" has a date in it and would waste a model call.
  const messages = messagesOnly(communications);
  if (messages.length === 0) {
    return { summary: "no messages to scan", usedModel: false };
  }

  const resolved = (prospect ??
    (cache?.bonzo_prospect_data as BonzoProspect | null) ??
    null) as BonzoProspect | null;

  const timeZone = await getUserTimezone(contact.user_id, supabase);

  /*
   * The budget gate covers the ambiguous-wording path only. It is checked up
   * front rather than inside the scan because a partial scan would advance the
   * watermark past messages it never really examined, and those would never be
   * looked at again.
   */
  const budget = await withinBudget(supabase, contact.user_id);
  if (!budget.ok) {
    return { summary: "over daily token budget; scan deferred", usedModel: false };
  }

  let usedModel = false;

  const scan = await scanForCallCommitments({
    userId: contact.user_id,
    contactId,
    prospect: resolved as unknown as Record<string, unknown>,
    communications: messages,
    scannedThrough: (cache?.calls_scanned_through as string | null) ?? null,
    brokerTimezone: timeZone,
    phone: contact.phone ?? null,
    onUsage: (usage) => {
      usedModel = true;
      void recordModelUsage(
        supabase,
        { userId: contact.user_id, purpose: "extract_call_time", contactId },
        usage
      );
    },
  });

  // Advanced only after a complete pass, so an aborted scan re-reads rather
  // than skipping messages it never examined.
  const newest = messages
    .map((c) => new Date(c.created_at).getTime())
    .filter((t) => Number.isFinite(t))
    .sort()
    .at(-1);

  if (newest) {
    await supabase
      .from("insights_cache")
      .upsert(
        {
          contact_id: contactId,
          user_id: contact.user_id,
          calls_scanned_through: new Date(newest).toISOString(),
        },
        { onConflict: "contact_id" }
      );
  }

  if (!scan.proposed) {
    return {
      summary: `scanned ${scan.messagesScanned} messages, no call found`,
      usedModel,
    };
  }

  const callId = await recordProposedCall(supabase, {
    userId: contact.user_id,
    contactId,
    scheduledAt: scan.proposed.scheduledAt,
    zone: scan.proposed.zone,
    candidate: scan.proposed.candidate,
  });

  if (!callId) {
    // recordProposedCall declines when a live call already exists for the
    // lead. Not an error — the reminder is already booked.
    return { summary: "a call is already scheduled for this lead", usedModel };
  }

  /*
   * Never auto-confirmed. A misparsed time is worse than no reminder: it puts
   * a call in the diary that the lead is not expecting, and Eddie finds out by
   * ringing someone at the wrong hour.
   */
  const { pushCallConfirmation } = await import("@/lib/telegram/call-confirm");
  await pushCallConfirmation(supabase, contact.user_id, callId).catch((e: unknown) =>
    console.error("[jobs/scan_calls] confirmation push failed:", e)
  );

  return {
    summary: `call proposed for ${contact.name} from ${scan.messagesScanned} messages`,
    usedModel,
  };
};
