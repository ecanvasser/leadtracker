/**
 * Callback handlers for the approval card.
 *
 * Idempotency has two layers, because they cover different failures:
 *
 *   processed_updates  — dedupes a Telegram webhook redelivery (same update_id)
 *   telegram_actions   — dedupes the same *intent* arriving twice, which is
 *                        what happens when the broker taps Send twice. Those
 *                        are two distinct updates, so update_id cannot help.
 *
 * Domain handlers stay idempotent regardless (see lib/outreach/send.ts). These
 * are the cheap first lines, not the only defence.
 */

import type { Context } from "grammy";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/service";
import { getUserIdByTelegramId } from "@/lib/db/telegram";
import { sendQueueItem, SendRefusedError } from "@/lib/outreach/send";
import {
  CB,
  SNOOZE_LABELS,
  renderApprovalCard,
  approvalKeyboard,
  snoozeKeyboard,
  escapeHtml,
  type SnoozeOption,
} from "@/lib/telegram/approval-card";
import { buildCardInput, pushNextCard, releaseCard } from "@/lib/telegram/push";
import { DIGEST_START, handleDigestStart } from "@/lib/telegram/digest";
import { isCallCallback, handleCallCallback } from "@/lib/telegram/call-confirm";
import { addLocalDays, getUserTimezone, localDate } from "@/lib/time";
import type { SessionData } from "@/lib/telegram/session";

/**
 * Claims a one-shot action for a queue item.
 *
 * Returns false when this exact action was already recorded — the unique index
 * on (queue_item_id, action) is what makes a double tap safe.
 */
export async function claimAction(
  supabase: SupabaseClient,
  userId: string,
  queueItemId: string,
  action: string
): Promise<boolean> {
  const { error } = await supabase
    .from("telegram_actions")
    .insert({ user_id: userId, queue_item_id: queueItemId, action });

  if (error) {
    if (error.code === "23505") return false; // already claimed
    throw error;
  }
  return true;
}

/** Parses "qs:<uuid>" or "qza:<uuid>:2h". */
export function parseCallback(
  data: string
): { code: string; queueItemId: string; arg?: string } | null {
  const parts = data.split(":");
  if (parts.length < 2) return null;
  return { code: parts[0], queueItemId: parts[1], arg: parts[2] };
}

const KNOWN_CODES = new Set<string>(Object.values(CB));

export function isApprovalCallback(data: string): boolean {
  const parsed = parseCallback(data);
  return parsed !== null && KNOWN_CODES.has(parsed.code);
}

/** When a snooze option lands, in absolute terms. */
export function snoozeUntil(
  option: SnoozeOption,
  now: Date,
  timeZone: string
): Date {
  switch (option) {
    case "2h":
      return new Date(now.getTime() + 2 * 60 * 60 * 1000);
    case "3d":
      return atLocalHour(addLocalDays(localDate(now, timeZone), 3), 9, timeZone);
    case "wk":
      return atLocalHour(addLocalDays(localDate(now, timeZone), 7), 9, timeZone);
    case "am":
    default:
      return atLocalHour(addLocalDays(localDate(now, timeZone), 1), 9, timeZone);
  }
}

/**
 * 9am on a local date, as an instant.
 *
 * Built by probing the zone rather than assuming a fixed offset, so a snooze
 * across a DST boundary still lands at 9am local.
 */
function atLocalHour(date: string, hour: number, timeZone: string): Date {
  const guess = new Date(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hour12: false,
  }).formatToParts(guess);
  const observed = Number(parts.find((p) => p.type === "hour")?.value ?? hour);
  const shift = (hour - observed) * 60 * 60 * 1000;
  return new Date(guess.getTime() + shift);
}

/**
 * Handles every approval-card callback.
 *
 * Returns true when it consumed the callback, so the generic command handler
 * can ignore it.
 */
export async function handleApprovalCallback(
  ctx: Context,
  session: SessionData
): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return false;

  const supabase = createServiceClient();

  // The digest's Start button carries no queue item id.
  if (data === DIGEST_START) {
    const digestUser = await getUserIdByTelegramId(supabase, ctx.from.id);
    if (!digestUser) {
      await ctx.answerCallbackQuery({ text: "Not linked to an account." });
      return true;
    }
    await ctx.answerCallbackQuery();
    const problem = await handleDigestStart(supabase, digestUser);
    if (problem) await ctx.reply(problem);
    else await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    return true;
  }

  // Call confirmation and outcome buttons.
  if (isCallCallback(data)) {
    const callUser = await getUserIdByTelegramId(supabase, ctx.from.id);
    if (!callUser) {
      await ctx.answerCallbackQuery({ text: "Not linked to an account." });
      return true;
    }
    await ctx.answerCallbackQuery();
    const outcome = await handleCallCallback(supabase, callUser, data);
    if (outcome) {
      try {
        const original = ctx.callbackQuery?.message;
        const existing = original && "text" in original ? (original.text ?? "") : "";
        await ctx.editMessageText(`${escapeHtml(existing)}\n\n${outcome}`, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [] },
        });
      } catch {
        await ctx.reply(outcome);
      }
    }
    return true;
  }

  const parsed = parseCallback(data);
  if (!parsed || !KNOWN_CODES.has(parsed.code)) return false;

  const userId = await getUserIdByTelegramId(supabase, ctx.from.id);
  if (!userId) {
    await ctx.answerCallbackQuery({ text: "Not linked to an account." });
    return true;
  }

  const { code, queueItemId, arg } = parsed;

  switch (code) {
    case CB.snoozeMenu:
      await ctx.answerCallbackQuery();
      await ctx.editMessageReplyMarkup({ reply_markup: snoozeKeyboard(queueItemId) });
      return true;

    case CB.back: {
      await ctx.answerCallbackQuery();
      const input = await buildCardInput(supabase, queueItemId);
      if (input) {
        await ctx.editMessageReplyMarkup({
          reply_markup: approvalKeyboard({
            queueItemId,
            actionType: input.actionType,
            bonzoProspectId: input.bonzoProspectId,
          }),
        });
      }
      return true;
    }

    case CB.snoozeApply:
      await applySnooze(ctx, supabase, userId, queueItemId, (arg as SnoozeOption) ?? "am");
      return true;

    case CB.skip:
      await applySkip(ctx, supabase, userId, queueItemId);
      return true;

    case CB.send:
      await applySend(ctx, supabase, userId, queueItemId);
      return true;

    case CB.edit:
      await ctx.answerCallbackQuery();
      session.action = "queue_edit";
      session.queueItemId = queueItemId;
      await ctx.reply(
        "Send me the replacement text. Your next message becomes the body verbatim, then it sends."
      );
      return true;

    case CB.redraft:
      await ctx.answerCallbackQuery();
      session.action = "queue_redraft";
      session.queueItemId = queueItemId;
      await ctx.reply(
        'What should change? For example: "shorter", "drop the second sentence", "mention the credit timeline".'
      );
      return true;

    default:
      return false;
  }
}

async function applySend(
  ctx: Context,
  supabase: SupabaseClient,
  userId: string,
  queueItemId: string,
  overrideBody?: string
): Promise<void> {
  // Claim before sending. A second tap loses the race and is answered without
  // anything reaching Bonzo.
  const claimed = await claimAction(supabase, userId, queueItemId, "send");
  if (!claimed) {
    await ctx.answerCallbackQuery({ text: "Already sent." });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Sending…" });

  try {
    const outcome = await sendQueueItem(supabase, userId, queueItemId, {
      ...(overrideBody !== undefined ? { overrideBody } : {}),
    });

    await finishCard(ctx, supabase, userId, queueItemId, `✅ ${outcome.receipt}`);
  } catch (e) {
    const message =
      e instanceof SendRefusedError ? e.message : "Send failed for an unknown reason.";

    // The claim is released so a fixed message can be retried. Failing to do
    // this would leave the card permanently un-sendable.
    await supabase
      .from("telegram_actions")
      .delete()
      .eq("queue_item_id", queueItemId)
      .eq("action", "send");

    await ctx.reply(`⚠️ ${escapeHtml(message)}`, { parse_mode: "HTML" });
  }
}

async function applySkip(
  ctx: Context,
  supabase: SupabaseClient,
  userId: string,
  queueItemId: string
): Promise<void> {
  const claimed = await claimAction(supabase, userId, queueItemId, "skip");
  if (!claimed) {
    await ctx.answerCallbackQuery({ text: "Already skipped." });
    return;
  }

  await ctx.answerCallbackQuery();

  const { data: item } = await supabase
    .from("daily_queue")
    .select("contact_id, action_type, draft_message, email_subject")
    .eq("id", queueItemId)
    .maybeSingle();

  await supabase
    .from("daily_queue")
    .update({ status: "skipped", completed_at: new Date().toISOString() })
    .eq("id", queueItemId);

  if (item) {
    await supabase.from("outreach_log").insert({
      user_id: userId,
      contact_id: item.contact_id,
      action_type: item.action_type,
      status: "skipped",
      draft_message: item.draft_message,
      email_subject: item.email_subject ?? null,
    });
  }

  await finishCard(ctx, supabase, userId, queueItemId, "⏭ Skipped.");
}

async function applySnooze(
  ctx: Context,
  supabase: SupabaseClient,
  userId: string,
  queueItemId: string,
  option: SnoozeOption
): Promise<void> {
  await ctx.answerCallbackQuery();

  const timeZone = await getUserTimezone(userId, supabase);
  const until = snoozeUntil(option, new Date(), timeZone);

  // Snooze stays pending on purpose — it is "not right now", not "not this",
  // so it comes back rather than being logged as a decision.
  await supabase
    .from("daily_queue")
    .update({ snoozed_until: until.toISOString(), telegram_message_id: null })
    .eq("id", queueItemId);

  await editCardFooter(ctx, `⏰ Snoozed — back ${SNOOZE_LABELS[option].toLowerCase()}.`);
  await pushNextIfQuiet(supabase, userId);
}

/**
 * Finalises a card: strips its buttons, appends the outcome, frees the slot,
 * and lets the next card through.
 */
async function finishCard(
  ctx: Context,
  supabase: SupabaseClient,
  userId: string,
  queueItemId: string,
  footer: string
): Promise<void> {
  await editCardFooter(ctx, footer);
  await releaseCard(supabase, queueItemId);
  await pushNextIfQuiet(supabase, userId);
}

/** Rewrites the card in place with its outcome and no live buttons. */
async function editCardFooter(ctx: Context, footer: string): Promise<void> {
  try {
    const original = ctx.callbackQuery?.message;
    const existing =
      original && "text" in original ? (original.text ?? "") : "";
    // Re-escape: ctx gives plain text, and the message is sent as HTML.
    await ctx.editMessageText(`${escapeHtml(existing)}\n\n${footer}`, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] },
    });
  } catch {
    // Editing fails if the message is too old or unchanged; the outcome still
    // stands, so this is not worth surfacing.
  }
}

async function pushNextIfQuiet(
  supabase: SupabaseClient,
  userId: string
): Promise<void> {
  try {
    await pushNextCard(supabase, userId);
  } catch (e) {
    console.error("[telegram/approval] failed to push next card:", e);
  }
}

/**
 * Handles the text reply that follows Edit or Redraft.
 *
 * Returns true when it consumed the message.
 */
export async function handleApprovalText(
  ctx: Context,
  session: SessionData,
  clear: () => void
): Promise<boolean> {
  const text = ctx.message?.text?.trim();
  if (!text || !ctx.from) return false;

  const action = session.action;
  if (action !== "queue_edit" && action !== "queue_redraft") return false;

  const queueItemId = session.queueItemId;
  if (!queueItemId) {
    clear();
    return false;
  }

  const supabase = createServiceClient();
  const userId = await getUserIdByTelegramId(supabase, ctx.from.id);
  if (!userId) {
    clear();
    return true;
  }

  if (action === "queue_edit") {
    clear();
    // The broker's text is the message, verbatim. It is not re-drafted, not
    // re-validated, and not "improved" — he wrote it, it sends as written.
    await applySend(ctx, supabase, userId, queueItemId, text);
    return true;
  }

  clear();
  await ctx.reply("Redrafting…");
  await redraft(ctx, supabase, userId, queueItemId, text);
  return true;
}

/** Regenerates a draft from an instruction and re-presents it for approval. */
async function redraft(
  ctx: Context,
  supabase: SupabaseClient,
  userId: string,
  queueItemId: string,
  instruction: string
): Promise<void> {
  const { reviseQueueDraft } = await import("@/lib/ai/revise");

  try {
    const revised = await reviseQueueDraft(supabase, userId, queueItemId, instruction);

    await supabase
      .from("daily_queue")
      .update({
        draft_message: revised.body,
        ...(revised.subject !== null ? { email_subject: revised.subject } : {}),
      })
      .eq("id", queueItemId);

    const input = await buildCardInput(supabase, queueItemId);
    if (!input) return;

    await ctx.reply(renderApprovalCard(input), {
      parse_mode: "HTML",
      reply_markup: approvalKeyboard({
        queueItemId,
        actionType: input.actionType,
        bonzoProspectId: input.bonzoProspectId,
      }),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Redraft failed.";
    await ctx.reply(`⚠️ ${escapeHtml(message)}`, { parse_mode: "HTML" });
  }
}
