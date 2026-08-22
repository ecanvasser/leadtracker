/**
 * The approval card — the primary surface of the whole app.
 *
 * One card, one lead, one decision. It has to carry enough for the broker to
 * approve without opening anything else: who, why now, what the prospect
 * actually said, and exactly what will be sent.
 *
 * The draft goes in a <pre> block so it renders as the literal characters that
 * will be delivered. Any formatting applied to it would be a lie about what
 * the prospect receives.
 */

import { InlineKeyboard } from "grammy";
import { LOAN_TYPE_LABELS, type LoanType } from "@/types/db";
import type { LeadState } from "@/lib/insights/lead-state";

/** Telegram caps callback_data at 64 bytes, so action codes are short. */
export const CB = {
  send: "qs",
  skip: "qk",
  snoozeMenu: "qz",
  snoozeApply: "qza",
  back: "qb",
} as const;

export type SnoozeOption = "2h" | "am" | "3d" | "wk";

export const SNOOZE_LABELS: Record<SnoozeOption, string> = {
  "2h": "2 hours",
  am: "Tomorrow AM",
  "3d": "3 days",
  wk: "Next week",
};

export interface ApprovalCardInput {
  queueItemId: string;
  contactName: string;
  loanType: LoanType;
  leadAgeDays: number;
  actionType: "sms" | "email" | "call";
  draftMessage: string | null;
  emailSubject: string | null;
  callTalkingPoints: string | null;
  priorityReason: string;
  touchLabel: string | null;
  leadState: LeadState | null;
  /** Most recent inbound message, shown verbatim. */
  lastInbound: { content: string; created_at: string } | null;
  bonzoProspectId: number | null;
  /**
   * Phase 7 retirement: nothing sets this any more — the validator that
   * produced it is gone. Kept on the card input so historical daily_queue rows
   * that still carry a stored draft render the way they always did.
   */
  unvalidatedReasons?: string[];
}

const TEMP_BADGE: Record<string, string> = {
  in_market: "🔥 In market",
  warming: "🌤 Warming",
  stalled: "⏸ Stalled",
  blocked: "🚧 Blocked",
  unresponsive: "🔇 Unresponsive",
};

const BLOCKER_LABEL: Record<string, string> = {
  none: "",
  prior_denial: "prior denial",
  credit: "credit",
  equity: "equity",
  income: "income",
  dti: "DTI",
  property: "property",
  timing: "timing",
  rate_shopping: "rate shopping",
  competitor: "competitor",
  non_responsive: "no response",
};

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Telegram rejects messages over 4096 characters. */
const MAX_LEN = 4096;

export function renderApprovalCard(input: ApprovalCardInput): string {
  const lines: string[] = [];

  // --- Header: who, what, how old -----------------------------------------
  const age =
    input.leadAgeDays === 0
      ? "day 0"
      : `day ${input.leadAgeDays}`;
  lines.push(
    `<b>${escapeHtml(input.contactName)}</b> · ${LOAN_TYPE_LABELS[input.loanType]} · ${age}`
  );

  // --- State badges -------------------------------------------------------
  const badges: string[] = [];
  if (input.leadState) {
    badges.push(TEMP_BADGE[input.leadState.lead_temp] ?? input.leadState.lead_temp);
    const blocker = BLOCKER_LABEL[input.leadState.blocker];
    if (blocker) {
      const confidence =
        input.leadState.blocker_confidence === "low" ? " (low confidence)" : "";
      badges.push(`blocker: ${blocker}${confidence}`);
    }
  }
  if (input.touchLabel) badges.push(input.touchLabel);
  if (badges.length) lines.push(badges.join(" · "));

  // --- Why now ------------------------------------------------------------
  const why = input.leadState?.why_now?.trim() || input.priorityReason;
  if (why) lines.push(`\n<i>${escapeHtml(why)}</i>`);

  // --- Blocker evidence, verbatim -----------------------------------------
  // Shown because a blocker without its quote is exactly the confident guess
  // the engine is built to avoid presenting as fact.
  if (input.leadState?.blocker_evidence) {
    lines.push(
      `\nEvidence: <i>“${escapeHtml(truncate(input.leadState.blocker_evidence, 200))}”</i>`
    );
  }

  // --- What the prospect last said ----------------------------------------
  if (input.lastInbound) {
    const when = shortDate(input.lastInbound.created_at);
    lines.push(
      `\n<b>They said</b> (${when}):\n<blockquote>${escapeHtml(
        truncate(input.lastInbound.content, 500)
      )}</blockquote>`
    );
  }

  // --- The draft ----------------------------------------------------------
  if (input.actionType === "call") {
    lines.push(`\n<b>📞 Call — talking points</b>`);
    if (input.callTalkingPoints) {
      lines.push(`<pre>${escapeHtml(input.callTalkingPoints)}</pre>`);
    }
    lines.push(`<i>Place the call in Bonzo. Nothing is sent from here.</i>`);
  } else {
    const channel = input.actionType === "email" ? "Email" : "SMS";
    lines.push(`\n<b>${channel} draft</b>`);
    if (input.emailSubject) {
      lines.push(`Subject: ${escapeHtml(input.emailSubject)}`);
    }
    lines.push(`<pre>${escapeHtml(input.draftMessage ?? "(no draft)")}</pre>`);
  }

  // --- Validation warning -------------------------------------------------
  if (input.unvalidatedReasons?.length) {
    lines.push(
      `\n⚠️ <b>Unvalidated</b> — ${escapeHtml(input.unvalidatedReasons.join("; "))}`
    );
  }

  const text = lines.join("\n");
  return text.length > MAX_LEN ? text.slice(0, MAX_LEN - 20) + "\n…(truncated)" : text;
}

export function approvalKeyboard(input: {
  queueItemId: string;
  actionType: "sms" | "email" | "call";
  bonzoProspectId: number | null;
}): InlineKeyboard {
  const kb = new InlineKeyboard();
  const id = input.queueItemId;

  if (input.actionType === "call") {
    // A call is never drafted or sent from here — only logged or deferred.
    kb.text("✅ Done", `${CB.send}:${id}`).text("⏰ Snooze", `${CB.snoozeMenu}:${id}`);
    kb.row().text("⏭ Skip", `${CB.skip}:${id}`);
  } else {
    // Phase 7 retirement: Edit and Redraft are gone with the drafting
    // subsystem. Section 5 replaces Send outright with Hand off / Mark
    // adverse; until then a message card offers only Send, Snooze and Skip.
    kb.text("✅ Send", `${CB.send}:${id}`).text("⏰ Snooze", `${CB.snoozeMenu}:${id}`);
    kb.row().text("⏭ Skip", `${CB.skip}:${id}`);
  }

  if (input.bonzoProspectId) {
    kb.row().url("Open in Bonzo", bonzoProspectUrl(input.bonzoProspectId));
  }

  return kb;
}

export function snoozeKeyboard(queueItemId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(SNOOZE_LABELS["2h"], `${CB.snoozeApply}:${queueItemId}:2h`)
    .text(SNOOZE_LABELS.am, `${CB.snoozeApply}:${queueItemId}:am`)
    .row()
    .text(SNOOZE_LABELS["3d"], `${CB.snoozeApply}:${queueItemId}:3d`)
    .text(SNOOZE_LABELS.wk, `${CB.snoozeApply}:${queueItemId}:wk`)
    .row()
    .text("← Back", `${CB.back}:${queueItemId}`);
}

/** Deep link to the prospect. The app only ever links out; it never dials. */
export function bonzoProspectUrl(prospectId: number): string {
  return `https://platform.getbonzo.com/prospect/${prospectId}`;
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "unknown";
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return d.toISOString().slice(0, 10);
}
