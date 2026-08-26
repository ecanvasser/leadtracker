/**
 * /calls — what's booked, from the phone.
 *
 * The reminder Edge Function already fires at T-15 and T-0. This is the other
 * half: being able to ask, rather than only being told. Eddie is usually in
 * Bonzo or in the car when he wants to know whether he owes someone a call in
 * the next hour, and opening the app to find out is the thing that made him
 * lose track in the first place.
 */

import type { Context } from "grammy";
import { createServiceClient } from "@/lib/supabase/service";
import {
  callsForDay,
  overdueCalls,
  wantsCallLeads,
  type DayCall,
} from "@/lib/calls/book";
import { addLocalDays, getUserTimezone, localDate } from "@/lib/time";
import { bonzoProspectUrl } from "@/lib/turn/links";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function line(call: DayCall, timeZone: string): string {
  const at = new Date(call.scheduled_at);
  const mine = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(at);

  const parts = [`<b>${mine}</b> — ${escapeHtml(call.contact_name)}`];

  if (call.phone) parts.push(escapeHtml(call.phone));

  // Their zone only when it differs. On every row it is noise; on the row
  // where it matters it prevents a 7am phone call.
  if (call.prospect_timezone !== timeZone) {
    const theirs = new Intl.DateTimeFormat("en-US", {
      timeZone: call.prospect_timezone,
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(at);
    parts.push(`(${theirs} their time)`);
  }

  if (call.status === "proposed") parts.push("⚠️ not confirmed");

  let out = parts.join(" · ");

  const why = call.note ?? call.source_quote;
  if (why) out += `\n   <i>${escapeHtml(why)}</i>`;

  const url = call.bonzo_prospect_id ? bonzoProspectUrl(call.bonzo_prospect_id) : null;
  if (url) out += `\n   <a href="${url}">Open in Bonzo</a>`;

  return out;
}

export async function handleCalls(ctx: Context): Promise<void> {
  const telegramUserId = ctx.from?.id;
  if (!telegramUserId) return;

  const supabase = createServiceClient();
  const { data: link } = await supabase
    .from("telegram_links")
    .select("user_id")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();

  if (!link) {
    await ctx.reply("This chat is not linked to an account yet.");
    return;
  }

  const userId = link.user_id as string;
  const timeZone = await getUserTimezone(userId, supabase);
  const today = localDate(new Date(), timeZone);
  const tomorrow = addLocalDays(today, 1);

  const [todayCalls, tomorrowCalls, overdue, wants] = await Promise.all([
    callsForDay(supabase, userId, timeZone, today),
    callsForDay(supabase, userId, timeZone, tomorrow),
    overdueCalls(supabase, userId),
    wantsCallLeads(supabase, userId),
  ]);

  const sections: string[] = [];

  if (overdue.length > 0) {
    sections.push(
      `<b>Went by without an outcome</b>\n` +
        overdue.map((c) => line(c, timeZone)).join("\n")
    );
  }

  sections.push(
    todayCalls.length > 0
      ? `<b>Today</b>\n${todayCalls.map((c) => line(c, timeZone)).join("\n")}`
      : "<b>Today</b>\nNothing booked."
  );

  if (tomorrowCalls.length > 0) {
    sections.push(
      `<b>Tomorrow</b>\n${tomorrowCalls.map((c) => line(c, timeZone)).join("\n")}`
    );
  }

  if (wants.length > 0) {
    // Listed last: a request with no time is real work, but it is not a
    // deadline, and it must not push a call that starts in ten minutes down
    // the screen.
    sections.push(
      `<b>Asked to talk — no time set</b>\n` +
        wants
          .map(
            (w) =>
              `${escapeHtml(w.contact_name)}\n   <i>${escapeHtml(w.quote)}</i>`
          )
          .join("\n")
    );
  }

  await ctx.reply(sections.join("\n\n"), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}
