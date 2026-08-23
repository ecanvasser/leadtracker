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
import { bonzoProspectUrl } from "@/lib/turn/links";
import { LOAN_TYPE_LABELS, type LoanType } from "@/types/db";
import type { LeadState } from "@/lib/insights/lead-state";

/** Telegram caps callback_data at 64 bytes, so action codes are short. */
export const CB = {
  send: "qs",
  edit: "qe",
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

/**
 * Phase 7: badges describe what the lead did with the number, not how warm
 * they are. Every lead on a card has already been pitched.
 */
const PITCH_BADGE: Record<string, string> = {
  no_response: "🔇 No reply",
  soft_no: "🚪 Soft no",
  price_objection: "💲 Price",
  timing_objection: "🕰 Timing",
  competitor: "🏦 Competitor",
  needs_info: "❓ Needs info",
  positive_intent: "🔥 Interested",
  converted_signal: "✅ Reads like a yes",
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
    const st = input.leadState;
    badges.push(PITCH_BADGE[st.pitch_response] ?? st.pitch_response);
    if (st.evidence_confidence === "low") badges.push("low confidence");
    // Section 5: days since pitch is on the card. Null reads as unknown rather
    // than 0, which would say "just pitched" about a lead going cold.
    if (st.days_since_pitch !== null) {
      badges.push(
        st.days_since_pitch === 1 ? "1 day since pitch" : `${st.days_since_pitch} days since pitch`
      );
    }
  }
  if (input.touchLabel) badges.push(input.touchLabel);
  if (badges.length) lines.push(badges.join(" · "));

  // --- The angle, not a draft ---------------------------------------------
  // Section 3.2: one line naming what to lead with. Eddie writes the message.
  const angle = input.leadState?.suggested_angle?.trim() || input.priorityReason;
  if (angle) lines.push(`\n<i>${escapeHtml(angle)}</i>`);

  // --- Evidence, verbatim --------------------------------------------------
  // Shown because a reading without its quote is exactly the confident guess
  // the classifier is built to avoid presenting as fact.
  if (input.leadState?.evidence) {
    lines.push(
      `\nEvidence: <i>“${escapeHtml(truncate(input.leadState.evidence, 200))}”</i>`
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
    // Phase 7 retirement removed Redraft with the drafting subsystem. Edit
    // stays: it pastes Eddie's own text verbatim, generates nothing, and with
    // draft_message now always null it is the only way a message goes out
    // from Telegram at all. Section 5 replaces these buttons.
    kb.text("✅ Send", `${CB.send}:${id}`).text("✏️ Edit", `${CB.edit}:${id}`);
    kb.row().text("⏰ Snooze", `${CB.snoozeMenu}:${id}`).text("⏭ Skip", `${CB.skip}:${id}`);
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

/**
 * Deep link to the prospect. The app only ever links out; it never dials.
 *
 * Defined in lib/turn/links.ts since Phase 8 — the Today row needs the same
 * link and this module imports grammY. Re-exported so existing callers are
 * untouched.
 */
export { bonzoProspectUrl };

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
