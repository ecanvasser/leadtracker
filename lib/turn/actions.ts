/**
 * The actions a Today row offers, on either surface.
 *
 * Extracted the moment the Telegram card needed them. Section 5.1 makes the
 * argument for the *reads* — the bot and the page must not be able to disagree
 * about the counts — and it applies at least as strongly to the writes. Two
 * implementations of Snooze would eventually disagree about where
 * `suppress_until` lives, and one of them would silently stop suppressing
 * anything.
 *
 * Every function takes a service client and checks ownership itself, because
 * the service client deliberately bypasses RLS and the Telegram path has no
 * session to fall back on.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getUserTimezone, localDate } from "@/lib/time";
import { ALL_STAGES, type AllStages } from "@/types/db";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

async function ownedContact(
  supabase: SupabaseClient,
  userId: string,
  contactId: string
): Promise<{ id: string; name: string; stage: AllStages } | null> {
  const { data } = await supabase
    .from("contacts")
    .select("id, name, stage")
    .eq("id", contactId)
    .eq("user_id", userId)
    .maybeSingle();
  return data ?? null;
}

/**
 * "I have handled this."
 *
 * Two effects, both records of something that already happened rather than
 * anything new: any task that was making the row actionable is closed, and
 * the action is logged. lib/turn/load.ts folds that log entry into the
 * outbound watermark, which is what moves the row out of Your move now
 * instead of at the next sweep.
 */
export async function markHandled(
  supabase: SupabaseClient,
  userId: string,
  contactId: string
): Promise<ActionResult & { name?: string; tasksClosed?: number }> {
  const contact = await ownedContact(supabase, userId, contactId);
  if (!contact) return { ok: false, error: "Contact not found" };

  const timeZone = await getUserTimezone(userId, supabase);
  const today = localDate(new Date(), timeZone);

  const { data: closed } = await supabase
    .from("tasks")
    .update({ is_done: true, completed_at: new Date().toISOString() })
    .eq("contact_id", contactId)
    .eq("user_id", userId)
    .eq("is_done", false)
    .lte("due_date", today)
    .select("id");

  await supabase.from("outreach_log").insert({
    user_id: userId,
    contact_id: contactId,
    action_type: "handled",
    // Not 'sent' — nothing was sent from here. 'done' is its own outcome and
    // the loader counts it alongside a real send, because both mean the ball
    // is back in the lead's court.
    status: "done",
    draft_message: "Marked done from Today",
  });

  return { ok: true, name: contact.name, tasksClosed: closed?.length ?? 0 };
}

/**
 * Snooze, or wake, a lead.
 *
 * Writes `suppress_until` on lead_state, which is where every other part of
 * the app already looks for it — the cadence engine, the classifier's hold
 * rule, and the queue's own snooze. A second mechanism would mean two places
 * to check before believing a lead is quiet on purpose.
 */
export async function setSnooze(
  supabase: SupabaseClient,
  userId: string,
  contactId: string,
  days: number | null
): Promise<ActionResult & { name?: string; until?: string | null }> {
  const contact = await ownedContact(supabase, userId, contactId);
  if (!contact) return { ok: false, error: "Contact not found" };

  const { data: cache } = await supabase
    .from("insights_cache")
    .select("lead_state")
    .eq("contact_id", contactId)
    .maybeSingle();

  const leadState = (cache?.lead_state as Record<string, unknown> | null) ?? {};

  const until =
    days === null
      ? null
      : new Date(
          Date.now() + Math.max(1, Math.min(90, days)) * 86_400_000
        ).toISOString();

  // upsert, not update: a lead the sweep has not reached yet has no cache
  // row, and an update would report success having written nothing.
  const { error } = await supabase.from("insights_cache").upsert(
    {
      contact_id: contactId,
      user_id: userId,
      lead_state: { ...leadState, suppress_until: until },
    },
    { onConflict: "contact_id" }
  );

  if (error) return { ok: false, error: error.message };
  return { ok: true, name: contact.name, until };
}

/**
 * Move a lead to a stage.
 *
 * The same write the board makes, so the same database trigger records it to
 * stage_transitions. Nothing about the history depends on which surface the
 * change came from.
 */
export async function setStage(
  supabase: SupabaseClient,
  userId: string,
  contactId: string,
  stage: AllStages
): Promise<ActionResult & { name?: string }> {
  if (!ALL_STAGES.includes(stage)) {
    return { ok: false, error: "A valid stage is required" };
  }

  const contact = await ownedContact(supabase, userId, contactId);
  if (!contact) return { ok: false, error: "Contact not found" };

  const { error } = await supabase
    .from("contacts")
    .update({ stage })
    .eq("id", contactId)
    .eq("user_id", userId);

  if (error) return { ok: false, error: error.message };
  return { ok: true, name: contact.name };
}
