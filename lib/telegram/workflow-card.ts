/**
 * Telegram surfaces for workflows.
 *
 * Two of them:
 *
 *   - A plain notice, for the notify_telegram action. No buttons; it has
 *     already happened.
 *   - An approval card, for a workflow that fired with requires_approval set.
 *     D2 makes that the default, and the card has to answer "who and why"
 *     before Eddie can reasonably press Send — a bare "Workflow fired,
 *     approve?" is worse than no automation, because approving it is a
 *     coin-flip he will start rubber-stamping.
 */

import { InlineKeyboard } from "grammy";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createBot } from "@/lib/telegram/bot";
import { escapeHtml, bonzoProspectUrl } from "@/lib/telegram/approval-card";
import { getTelegramLink } from "@/lib/db/telegram";

/** Callback codes. Telegram caps callback_data at 64 bytes. */
export const WF_CB = {
  approve: "wa",
  skip: "wk",
  revert: "wr",
} as const;

export interface WorkflowNotice {
  contactName: string;
  contactId: string;
  workflowName: string;
  message: string;
}

/** notify_telegram: a note about a lead, addressed to Eddie. */
export async function pushWorkflowNotice(
  supabase: SupabaseClient,
  userId: string,
  notice: WorkflowNotice
): Promise<void> {
  const link = await getTelegramLink(supabase, userId);
  if (!link) return;

  const bot = createBot();
  await bot.api.sendMessage(
    link.telegram_user_id,
    [
      `<b>${escapeHtml(notice.contactName)}</b>`,
      escapeHtml(notice.message),
      `\n<i>${escapeHtml(notice.workflowName)}</i>`,
    ].join("\n"),
    { parse_mode: "HTML" }
  );
}

export interface WorkflowApprovalCard {
  runId: string;
  contactName: string;
  loanTypeLabel: string;
  bonzoProspectId: number | null;
  workflowName: string;
  /** Plain-English description of what will happen if approved. */
  actionDescription: string;
  /** Why it fired — the trigger snapshot, rendered. */
  why: string;
  /** What the action will displace, when it replaces something. */
  displacing?: string | null;
}

export function renderWorkflowCard(card: WorkflowApprovalCard): string {
  const lines: string[] = [
    `<b>${escapeHtml(card.contactName)}</b> · ${escapeHtml(card.loanTypeLabel)}`,
    `\n${escapeHtml(card.actionDescription)}`,
    `\n<i>${escapeHtml(card.why)}</i>`,
  ];

  /*
   * Stated on the card, not buried in the workflow's config. Enrolment
   * replaces, so approving this pulls the lead out of whatever nurture
   * sequence they are in — and that sequence was chosen for a reason. Eddie
   * should see what he is about to undo at the moment he decides.
   */
  if (card.displacing) {
    lines.push(`\n⚠️ Replaces: ${escapeHtml(card.displacing)}`);
  }

  lines.push(`\n<i>${escapeHtml(card.workflowName)}</i>`);
  return lines.join("\n");
}

export function workflowKeyboard(card: {
  runId: string;
  bonzoProspectId: number | null;
}): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("✅ Send", `${WF_CB.approve}:${card.runId}`)
    .text("⏭ Skip", `${WF_CB.skip}:${card.runId}`);

  if (card.bonzoProspectId) {
    kb.row().url("Open in Bonzo", bonzoProspectUrl(card.bonzoProspectId));
  }
  return kb;
}

/** Offered after a campaign handoff executes, while undoing is still cheap. */
export function revertKeyboard(runId: string): InlineKeyboard {
  return new InlineKeyboard().text("↩️ Undo", `${WF_CB.revert}:${runId}`);
}

export async function pushWorkflowApproval(
  supabase: SupabaseClient,
  userId: string,
  card: WorkflowApprovalCard
): Promise<{ pushed: boolean; reason?: string }> {
  const link = await getTelegramLink(supabase, userId);
  if (!link) return { pushed: false, reason: "Telegram is not linked" };

  const bot = createBot();
  const sent = await bot.api.sendMessage(link.telegram_user_id, renderWorkflowCard(card), {
    parse_mode: "HTML",
    reply_markup: workflowKeyboard({
      runId: card.runId,
      bonzoProspectId: card.bonzoProspectId,
    }),
  });

  await supabase
    .from("workflow_runs")
    .update({ telegram_message_id: sent.message_id })
    .eq("id", card.runId);

  return { pushed: true };
}
