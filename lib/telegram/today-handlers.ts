/**
 * `/today` and its button taps.
 *
 * Both the command and the callbacks rebuild the card from `loadToday` after
 * acting, rather than patching the message text. Recomputing is cheap, and a
 * card edited in place would drift from what the counts actually are the
 * moment an action changes which section a lead belongs to — which is exactly
 * what these actions do.
 */

import { type Context } from "grammy";
import { createServiceClient } from "@/lib/supabase/service";
import { getUserIdByTelegramId } from "@/lib/db/telegram";
import { markHandled, setSnooze } from "@/lib/turn/actions";
import {
  TODAY_CB,
  buildTodayCard,
  snoozeKeyboard,
} from "@/lib/telegram/today-card";

export async function handleToday(ctx: Context) {
  if (!ctx.from) return;

  const supabase = createServiceClient();
  const userId = await getUserIdByTelegramId(supabase, ctx.from.id);
  if (!userId) {
    await ctx.reply(
      "You're not linked to an account yet.\nConnect via the web app Settings → Connect Telegram."
    );
    return;
  }

  const card = await buildTodayCard(supabase, userId);
  await ctx.reply(card.text, {
    parse_mode: "HTML",
    reply_markup: card.keyboard,
    // The rows carry no links of their own; a preview here would be Bonzo's
    // login page unfurled under every card.
    link_preview_options: { is_disabled: true },
  });
}

/**
 * Routes a Today callback. Returns true when it handled the tap, so the main
 * callback router can fall through to the other flows.
 *
 * Idempotency comes from the webhook's `processed_updates` check, which drops
 * a repeated update_id before grammY ever dispatches it — so a Telegram retry
 * cannot double-snooze a lead. Nothing here needs its own guard, and marking
 * a lead handled twice would be harmless in any case: it closes already-closed
 * tasks and writes a second log row, neither of which changes what the screen
 * says.
 */
export async function handleTodayCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return false;

  const isOurs =
    data === TODAY_CB.refresh ||
    data.startsWith(`${TODAY_CB.done}:`) ||
    data.startsWith(`${TODAY_CB.snooze}:`) ||
    data.startsWith(`${TODAY_CB.snoozeApply}:`);

  if (!isOurs) return false;

  const supabase = createServiceClient();
  const userId = await getUserIdByTelegramId(supabase, ctx.from.id);
  if (!userId) {
    await ctx.answerCallbackQuery({ text: "You're not linked." });
    return true;
  }

  // The snooze menu replaces the card's keyboard rather than its text, so the
  // leads stay readable while choosing how long to park one.
  if (data.startsWith(`${TODAY_CB.snooze}:`)) {
    const contactId = data.slice(TODAY_CB.snooze.length + 1);
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: snoozeKeyboard(contactId) });
    return true;
  }

  let toast = "";

  if (data.startsWith(`${TODAY_CB.done}:`)) {
    const contactId = data.slice(TODAY_CB.done.length + 1);
    const result = await markHandled(supabase, userId, contactId);
    toast = result.ok
      ? `${result.name} marked done`
      : (result.error ?? "That didn't go through");
  } else if (data.startsWith(`${TODAY_CB.snoozeApply}:`)) {
    const [, contactId, rawDays] = data.split(":");
    const result = await setSnooze(supabase, userId, contactId, Number(rawDays) || 1);
    toast = result.ok
      ? `${result.name} snoozed`
      : (result.error ?? "That didn't go through");
  }

  await ctx.answerCallbackQuery(toast ? { text: toast } : undefined);

  const card = await buildTodayCard(supabase, userId);
  await ctx.editMessageText(card.text, {
    parse_mode: "HTML",
    reply_markup: card.keyboard,
    link_preview_options: { is_disabled: true },
  });

  return true;
}
