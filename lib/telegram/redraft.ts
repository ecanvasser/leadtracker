/**
 * Redraft — "shorter", "lead with the credit", "drop the second line".
 *
 * Phase 8 6A.4. Eddie replies with an instruction and gets a new draft to
 * approve, on the same queue row, with the same buttons.
 *
 * The cap is the point of this module existing separately. 6A.6 names a
 * redraft loop as the obvious runaway cost risk, and it is: every "shorter" is
 * another pair of model calls, nothing about the loop is self-limiting, and
 * the daily token budget would only notice after the money was spent and by
 * shutting off classification too. The limit is per lead per day and it is
 * checked before the call, not after.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { draftOne } from "@/lib/ai/draft-one";
import { readDraftSettings } from "@/lib/jobs/draft-quoted";
import {
  type BonzoCommunication,
  type BonzoProspect,
} from "@/lib/bonzo/client";
import type { LeadState } from "@/lib/insights/lead-state";
import { endOfLocalDayUtc, localDate, startOfLocalDayUtc } from "@/lib/time";

/** Logged for every redraft, so the cap can count them separately. */
export const REDRAFT_ACTION = "draft_redrafted";

export interface RedraftOutcome {
  ok: boolean;
  body?: string;
  validated?: boolean;
  violations?: string[];
  /** Shown to Eddie when the redraft was refused. */
  refusal?: string;
  remaining?: number;
}

/**
 * How many redrafts this lead has had today, in local calendar days.
 *
 * Local rather than a rolling 24 hours because the cap is something Eddie
 * reasons about as "three a day", and a rolling window means the fourth
 * attempt at 9am is refused for something he did the previous afternoon.
 */
export async function redraftsToday(
  supabase: SupabaseClient,
  contactId: string,
  timeZone: string,
  now: Date = new Date()
): Promise<number> {
  const today = localDate(now, timeZone);
  const { data } = await supabase
    .from("outreach_log")
    .select("id")
    .eq("contact_id", contactId)
    .eq("action_type", REDRAFT_ACTION)
    .gte("created_at", startOfLocalDayUtc(today, timeZone).toISOString())
    .lt("created_at", endOfLocalDayUtc(today, timeZone).toISOString());

  return (data ?? []).length;
}

export async function redraftQueueItem(
  supabase: SupabaseClient,
  userId: string,
  queueItemId: string,
  instruction: string,
  now: Date = new Date()
): Promise<RedraftOutcome> {
  const { data: item } = await supabase
    .from("daily_queue")
    .select("id, user_id, contact_id, action_type, draft_message, status")
    .eq("id", queueItemId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!item) return { ok: false, refusal: "That card is gone." };
  if (item.status !== "pending") {
    return { ok: false, refusal: "That one has already been actioned." };
  }
  if (!(item.draft_message ?? "").trim()) {
    // Redraft revises; it does not conjure. A card with no draft is an
    // ordinary follow-up card, and drafting one would be exactly the
    // general-purpose path section 7 rules out.
    return { ok: false, refusal: "There's no draft on that card to revise." };
  }

  const settings = await readDraftSettings(supabase, userId);
  if (settings.mode === "off") {
    return { ok: false, refusal: "Drafting is switched off." };
  }

  const used = await redraftsToday(supabase, item.contact_id, settings.timeZone, now);
  if (used >= settings.maxRedraftsPerDay) {
    return {
      ok: false,
      refusal:
        `That's ${used} redrafts for this lead today, which is the limit. ` +
        `Use Edit to write it yourself, or come back tomorrow.`,
    };
  }

  const { data: contact } = await supabase
    .from("contacts")
    .select("id, name, stage, stage_changed_at")
    .eq("id", item.contact_id)
    .maybeSingle();

  if (!contact) return { ok: false, refusal: "That lead is gone." };

  const { data: cache } = await supabase
    .from("insights_cache")
    .select("lead_state, bonzo_communication, bonzo_prospect_data")
    .eq("contact_id", item.contact_id)
    .maybeSingle();

  const hoursSincePitch = contact.stage_changed_at
    ? (now.getTime() - new Date(contact.stage_changed_at).getTime()) / 3_600_000
    : null;

  const result = await draftOne({
    channel: item.action_type === "email" ? "email" : "sms",
    contactName: contact.name,
    brokerName: settings.brokerName,
    brokerCompany: settings.brokerCompany,
    prospect: (cache?.bonzo_prospect_data as BonzoProspect | null) ?? null,
    communications: (cache?.bonzo_communication ?? []) as BonzoCommunication[],
    leadState: (cache?.lead_state as LeadState | null) ?? null,
    hoursSincePitch,
    instruction,
    previous: item.draft_message as string,
  });

  // Logged before the row is updated, so a crash between the two leaves the
  // cap having counted a call that was actually made.
  await supabase.from("outreach_log").insert({
    user_id: userId,
    contact_id: item.contact_id,
    action_type: REDRAFT_ACTION,
    status: result.validated ? "drafted" : "drafted_unvalidated",
    draft_message: result.body,
    original_draft: item.draft_message,
  });

  await supabase
    .from("daily_queue")
    .update({
      draft_message: result.body,
      unvalidated_reasons: result.validated
        ? null
        : result.violations.map((v) => v.detail),
    })
    .eq("id", queueItemId);

  return {
    ok: true,
    body: result.body,
    validated: result.validated,
    violations: result.violations.map((v) => v.detail),
    remaining: Math.max(0, settings.maxRedraftsPerDay - used - 1),
  };
}
