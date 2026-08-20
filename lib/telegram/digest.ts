/**
 * The morning digest.
 *
 * The day's opening move: how much is waiting, the three that matter most, and
 * one tap to begin. Deliberately not a list of everything — a wall of forty
 * leads is a thing to scroll past, not act on.
 */

import { InlineKeyboard } from "grammy";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createBot } from "@/lib/telegram/bot";
import { getTelegramLink } from "@/lib/db/telegram";
import { escapeHtml } from "@/lib/telegram/approval-card";
import { pushNextCard } from "@/lib/telegram/push";
import { LOAN_TYPE_LABELS, type LoanType } from "@/types/db";
import type { LeadState } from "@/lib/insights/lead-state";

export const DIGEST_START = "dgstart";

export interface DigestItem {
  contactName: string;
  loanType: LoanType;
  actionType: string;
  whyNow: string;
  leadTemp: string | null;
}

export function renderDigest(items: DigestItem[], total: number): string {
  if (total === 0) {
    return [
      "<b>Nothing queued today.</b>",
      "",
      "No lead is due a touch, and nothing is waiting on a reply. That is a real answer, not a gap — the engine holds rather than manufacturing a reason to reach out.",
    ].join("\n");
  }

  const lines: string[] = [
    `<b>${total} ${total === 1 ? "lead" : "leads"} queued today</b>`,
    "",
  ];

  const shown = items.slice(0, 3);
  for (const item of shown) {
    const channel =
      item.actionType === "call" ? "call" : item.actionType === "email" ? "email" : "text";
    lines.push(
      `• <b>${escapeHtml(item.contactName)}</b> — ${LOAN_TYPE_LABELS[item.loanType]} · ${channel}`
    );
    if (item.whyNow) {
      lines.push(`  <i>${escapeHtml(truncate(item.whyNow, 120))}</i>`);
    }
  }

  if (total > shown.length) {
    lines.push("", `…and ${total - shown.length} more.`);
  }

  return lines.join("\n");
}

export function digestKeyboard(hasItems: boolean): InlineKeyboard | undefined {
  if (!hasItems) return undefined;
  return new InlineKeyboard().text("Start ▶︎", DIGEST_START);
}

/**
 * Sends the digest.
 *
 * Does not push a card with it — the digest is a summary, and the first card
 * goes out when the broker taps Start. Leading with a card would make the
 * digest itself the interruption it is meant to replace.
 */
export async function sendMorningDigest(
  supabase: SupabaseClient,
  userId: string,
  queueDate: string
): Promise<{ sent: boolean; reason?: string; total: number }> {
  const link = await getTelegramLink(supabase, userId);
  if (!link) return { sent: false, reason: "Telegram is not linked", total: 0 };

  const { data: rows } = await supabase
    .from("daily_queue")
    .select("contact_id, action_type, priority_reason, contacts(name, loan_type)")
    .eq("user_id", userId)
    .eq("queue_date", queueDate)
    .eq("status", "pending")
    .order("priority_rank", { ascending: true });

  const pending = rows ?? [];

  // why_now comes from lead state, which is per contact rather than per item.
  const contactIds = Array.from(new Set(pending.map((r) => r.contact_id)));
  const stateByContact = new Map<string, LeadState>();
  if (contactIds.length > 0) {
    const { data: caches } = await supabase
      .from("insights_cache")
      .select("contact_id, lead_state")
      .in("contact_id", contactIds);
    for (const c of caches ?? []) {
      if (c.lead_state) stateByContact.set(c.contact_id, c.lead_state as LeadState);
    }
  }

  const items: DigestItem[] = pending.map((r) => {
    const contact = r.contacts as unknown as { name: string; loan_type: LoanType };
    const state = stateByContact.get(r.contact_id);
    return {
      contactName: contact?.name ?? "Unknown",
      loanType: contact?.loan_type ?? "purchase",
      actionType: r.action_type,
      whyNow: state?.why_now?.trim() || r.priority_reason,
      leadTemp: state?.lead_temp ?? null,
    };
  });

  const bot = createBot();
  await bot.api.sendMessage(link.telegram_user_id, renderDigest(items, items.length), {
    parse_mode: "HTML",
    ...(digestKeyboard(items.length > 0)
      ? { reply_markup: digestKeyboard(items.length > 0) }
      : {}),
  });

  return { sent: true, total: items.length };
}

/** Handles the digest's Start button by releasing the first card. */
export async function handleDigestStart(
  supabase: SupabaseClient,
  userId: string
): Promise<string> {
  const result = await pushNextCard(supabase, userId);
  if (result.pushed) return "";
  return result.reason ?? "Nothing to start.";
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}
