import { InlineKeyboard } from "grammy";
import {
  LOAN_TYPES,
  CRM_OPTIONS,
  PIPELINE_STAGES,
  ALL_STAGES,
  ADVERSE_REASONS,
  LOAN_TYPE_LABELS,
  CRM_LABELS,
  STAGE_LABELS,
  ADVERSE_REASON_LABELS,
  type Contact,
  type TaskWithContact,
} from "@/types/db";

export function loanTypeKeyboard() {
  const kb = new InlineKeyboard();
  LOAN_TYPES.forEach((lt, i) => {
    kb.text(LOAN_TYPE_LABELS[lt], `lt:${lt}`);
    if (i % 2 === 1) kb.row();
  });
  return kb;
}

export function crmKeyboard() {
  const kb = new InlineKeyboard();
  CRM_OPTIONS.forEach((c) => kb.text(CRM_LABELS[c], `crm:${c}`));
  return kb;
}

/**
 * `includeTerminal` covers both off-board stages — Adverse and, since Phase 7,
 * Funded. It kept the name `includeAdverse` for one release too long after
 * Funded joined ALL_STAGES; the flag has always meant "offer the stages that
 * are not board columns".
 */
export function stageKeyboard(prefix = "stage", includeTerminal = true) {
  const kb = new InlineKeyboard();
  const stages = includeTerminal ? ALL_STAGES : PIPELINE_STAGES;
  stages.forEach((s) => kb.text(STAGE_LABELS[s], `${prefix}:${s}`).row());
  return kb;
}

export function contactListKeyboard(contacts: Contact[], prefix: string) {
  const kb = new InlineKeyboard();
  contacts.forEach((c) => {
    kb.text(`${c.name} (${LOAN_TYPE_LABELS[c.loan_type]})`, `${prefix}:${c.id}`).row();
  });
  return kb;
}

export function taskListKeyboard(tasks: TaskWithContact[], prefix: string) {
  const kb = new InlineKeyboard();
  tasks.slice(0, 20).forEach((t) => {
    const label = `${t.title} — ${t.contacts.name}`;
    kb.text(label.slice(0, 60), `${prefix}:${t.id}`).row();
  });
  return kb;
}

export function adverseReasonKeyboard(contactId: string) {
  const kb = new InlineKeyboard();
  ADVERSE_REASONS.forEach((r, i) => {
    kb.text(ADVERSE_REASON_LABELS[r], `adverse_reason:${contactId}:${r}`);
    if (i % 2 === 1) kb.row();
  });
  return kb;
}

export function confirmKeyboard(id: string) {
  return new InlineKeyboard()
    .text("Yes, delete", `confirm_delete:${id}`)
    .text("Cancel", "cancel");
}
