/**
 * Pushing approval cards.
 *
 * Throttled to one outstanding card at a time. Forty cards arriving at 8am is
 * a notification storm that gets muted, and a muted bot is a dead product —
 * the next card goes out when the current one is actioned.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createBot } from "@/lib/telegram/bot";
import {
  renderApprovalCard,
  approvalKeyboard,
  type ApprovalCardInput,
} from "@/lib/telegram/approval-card";
import { getTelegramLink } from "@/lib/db/telegram";
import { isInbound } from "@/lib/bonzo/client";
import type { LeadState } from "@/lib/insights/lead-state";
import type { LoanType } from "@/types/db";
import {
  leadAgeDays,
  localDateFor,
  isWithinQuietHours,
  getUserTimezone,
} from "@/lib/time";

export interface PushResult {
  pushed: boolean;
  reason?: string;
  queueItemId?: string;
  messageId?: number;
}

/**
 * Assembles the card for one queue item.
 *
 * Reads the lead state and last inbound message from the cache rather than
 * re-fetching: the card must reflect what the draft was written against, and
 * a fresher fetch here would show the broker a quote the draft never saw.
 */
export async function buildCardInput(
  supabase: SupabaseClient,
  queueItemId: string
): Promise<ApprovalCardInput | null> {
  const { data: item } = await supabase
    .from("daily_queue")
    .select(
      "id, contact_id, action_type, draft_message, email_subject, call_talking_points, priority_reason, touch_label, decision_trace, unvalidated_reasons, status"
    )
    .eq("id", queueItemId)
    .maybeSingle();

  if (!item) return null;

  const { data: contact } = await supabase
    .from("contacts")
    .select("name, loan_type, bonzo_prospect_id, created_at, user_id")
    .eq("id", item.contact_id)
    .maybeSingle();

  if (!contact) return null;

  const { data: cache } = await supabase
    .from("insights_cache")
    .select("lead_state, bonzo_communication")
    .eq("contact_id", item.contact_id)
    .maybeSingle();

  const comms = (cache?.bonzo_communication ?? []) as {
    content: string | null;
    direction: string;
    created_at: string;
  }[];

  const lastInbound = [...comms]
    .filter((c) => isInbound(c.direction) && (c.content ?? "").trim())
    .sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )[0];

  const trace = item.decision_trace as { validation?: { reasons?: string[] } } | null;

  // Phase 8 6A: drafting has its own three-state ladder, and dry run means the
  // card is readable but cannot send. Read here rather than at render time so
  // every surface that builds a card gets the same answer.
  const { data: settings } = await supabase
    .from("user_settings")
    .select("drafting_mode")
    .eq("user_id", contact.user_id)
    .maybeSingle();

  const hasDraft = Boolean((item.draft_message ?? "").trim());
  const isQuotedDraft = item.priority_reason === "Quoted-window draft";

  return {
    queueItemId: item.id,
    contactName: contact.name,
    loanType: contact.loan_type as LoanType,
    leadAgeDays: leadAgeDays(
      contact.created_at,
      await getUserTimezone(contact.user_id, supabase)
    ),
    actionType: item.action_type as "sms" | "email" | "call",
    draftMessage: item.draft_message,
    emailSubject: item.email_subject,
    callTalkingPoints: item.call_talking_points,
    priorityReason: item.priority_reason,
    touchLabel: item.touch_label,
    leadState: (cache?.lead_state as LeadState | null) ?? null,
    lastInbound: lastInbound
      ? { content: lastInbound.content ?? "", created_at: lastInbound.created_at }
      : null,
    bonzoProspectId: contact.bonzo_prospect_id,
    unvalidatedReasons:
      (item.unvalidated_reasons as string[] | null) ?? trace?.validation?.reasons,
    // Only a quoted-window draft is affected: an ordinary follow-up card has
    // nothing generated on it, so dry-run drafting has no bearing on it.
    readOnly:
      isQuotedDraft && (settings?.drafting_mode ?? "off") !== "live",
    canRedraft: isQuotedDraft && hasDraft,
  };
}

/**
 * Whether a card is already awaiting a decision.
 *
 * The throttle. A pending item that has been pushed and not yet actioned holds
 * the slot.
 */
export async function hasOutstandingCard(
  supabase: SupabaseClient,
  userId: string
): Promise<boolean> {
  const { count } = await supabase
    .from("daily_queue")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "pending")
    .not("telegram_message_id", "is", null);

  return (count ?? 0) > 0;
}

/** The next item eligible to be pushed, in priority order. */
export async function nextPushableItem(
  supabase: SupabaseClient,
  userId: string
): Promise<{ id: string } | null> {
  const today = await localDateFor(userId);
  const now = new Date().toISOString();

  const { data } = await supabase
    .from("daily_queue")
    .select("id, snoozed_until")
    .eq("user_id", userId)
    .eq("queue_date", today)
    .eq("status", "pending")
    .is("telegram_message_id", null)
    .or(`snoozed_until.is.null,snoozed_until.lte.${now}`)
    .order("priority_rank", { ascending: true })
    .limit(1)
    .maybeSingle();

  return data ?? null;
}

/**
 * Pushes the next card if the slot is free and it is not quiet hours.
 *
 * Returns why it declined rather than throwing, since "nothing to push" is the
 * normal case on most ticks.
 */
export async function pushNextCard(
  supabase: SupabaseClient,
  userId: string
): Promise<PushResult> {
  const quiet = await isWithinQuietHours(userId);
  if (quiet) return { pushed: false, reason: "quiet hours" };

  if (await hasOutstandingCard(supabase, userId)) {
    return { pushed: false, reason: "a card is already awaiting a decision" };
  }

  const next = await nextPushableItem(supabase, userId);
  if (!next) return { pushed: false, reason: "nothing pending" };

  return pushCard(supabase, userId, next.id);
}

/** Pushes one specific item, bypassing the throttle. */
export async function pushCard(
  supabase: SupabaseClient,
  userId: string,
  queueItemId: string
): Promise<PushResult> {
  const link = await getTelegramLink(supabase, userId);
  if (!link) return { pushed: false, reason: "Telegram is not linked" };

  const input = await buildCardInput(supabase, queueItemId);
  if (!input) return { pushed: false, reason: "queue item is gone" };

  const bot = createBot();
  const sent = await bot.api.sendMessage(
    link.telegram_user_id,
    renderApprovalCard(input),
    {
      parse_mode: "HTML",
      reply_markup: approvalKeyboard({
        queueItemId: input.queueItemId,
        actionType: input.actionType,
        bonzoProspectId: input.bonzoProspectId,
        readOnly: input.readOnly,
        canRedraft: input.canRedraft,
      }),
    }
  );

  // Recording the message id is what marks the slot taken, so it happens only
  // after Telegram confirms delivery.
  await supabase
    .from("daily_queue")
    .update({
      telegram_message_id: sent.message_id,
      pushed_at: new Date().toISOString(),
    })
    .eq("id", queueItemId);

  return { pushed: true, queueItemId, messageId: sent.message_id };
}

/**
 * Frees the slot after an item is actioned.
 *
 * Clearing telegram_message_id is what lets the next card through, so every
 * terminal action must call this.
 */
export async function releaseCard(
  supabase: SupabaseClient,
  queueItemId: string
): Promise<void> {
  await supabase
    .from("daily_queue")
    .update({ telegram_message_id: null })
    .eq("id", queueItemId);
}
