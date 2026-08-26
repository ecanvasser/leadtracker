import { type Context } from "grammy";
import { createServiceClient } from "@/lib/supabase/service";
import { handleWorkflowCallback } from "@/lib/telegram/workflow-handlers";
import { handleTodayCallback } from "@/lib/telegram/today-handlers";
import { getUserIdByTelegramId, redeemLinkToken } from "@/lib/db/telegram";
import { withSession, type SessionData } from "@/lib/telegram/session";
import {
  handleApprovalCallback,
  handleApprovalText,
} from "@/lib/telegram/approval-handlers";
import {
  getAllContacts,
  createContact,
  updateContact,
  deleteContact,
} from "@/lib/db/contacts";
import { getOpenTasks, createTask, completeTask } from "@/lib/db/tasks";
import {
  LOAN_TYPE_LABELS,
  STAGE_LABELS,
  ALL_STAGES,
  ADVERSE_REASON_LABELS,
  type LoanType,
  type CRM,
  type PipelineStage,
  type AllStages,
  type AdverseReason,
} from "@/types/db";
import {
  loanTypeKeyboard,
  crmKeyboard,
  stageKeyboard,
  contactListKeyboard,
  taskListKeyboard,
  confirmKeyboard,
  adverseReasonKeyboard,
} from "./keyboards";

/**
 * Flow handlers receive their session state and a clear() rather than reaching
 * for a module-level map. See lib/telegram/session.ts for why.
 */
type Clear = () => void;

/** Wraps a flow handler so its session is loaded and persisted around it. */
function inSession(
  fn: (ctx: Context, session: SessionData, clear: Clear) => Promise<void>
): (ctx: Context) => Promise<void> {
  return async (ctx: Context) => {
    if (!ctx.from) return;
    const supabase = createServiceClient();
    await withSession(supabase, ctx.from.id, (handle) =>
      fn(ctx, handle.data, () => handle.clear())
    );
  };
}

async function resolveUser(ctx: Context): Promise<string | null> {
  if (!ctx.from) return null;
  const supabase = createServiceClient();
  return getUserIdByTelegramId(supabase, ctx.from.id);
}

async function requireUser(ctx: Context): Promise<string | null> {
  const userId = await resolveUser(ctx);
  if (!userId) {
    await ctx.reply(
      "You're not linked to an account yet.\nConnect via the web app Settings → Connect Telegram."
    );
  }
  return userId;
}

export async function handleStart(ctx: Context) {
  const payload = ctx.match as string | undefined;

  if (payload) {
    const supabase = createServiceClient();
    try {
      const userId = await redeemLinkToken(supabase, payload, ctx.from!.id);
      if (userId) {
        await ctx.reply("Account linked! You're all set.\nType /help to see commands.");
        return;
      }
      await ctx.reply("That link is invalid or expired. Generate a new one from Settings.");
    } catch {
      await ctx.reply("Something went wrong linking your account. Try again from Settings.");
    }
    return;
  }

  const userId = await resolveUser(ctx);
  if (userId) {
    await ctx.reply("Welcome back! Type /help to see commands.");
  } else {
    await ctx.reply(
      "Welcome to Mortgage Tracker Bot!\nLink your account via the web app Settings → Connect Telegram."
    );
  }
}

export async function handleHelp(ctx: Context) {
  await ctx.reply(
    "<b>Commands:</b>\n\n" +
      "/today — Whose move is it: your move, overdue, waiting\n" +
      "/calls — Calls booked today and tomorrow\n" +
      "/todo — View open tasks\n" +
      "/add — Add a new contact\n" +
      "/list — List contacts (optionally by stage)\n" +
      "/move — Move a contact to a new stage\n" +
      "/task — Add a task to a contact\n" +
      "/done — Mark a task complete\n" +
      "/delete — Delete a contact\n" +
      "/pause — Stop all workflows\n" +
      "/resume — Start them again\n" +
      "/help — Show this message",
    { parse_mode: "HTML" }
  );
}

export async function handleTodo(ctx: Context) {
  const userId = await requireUser(ctx);
  if (!userId) return;

  const supabase = createServiceClient();
  const tasks = await getOpenTasks(supabase);
  const userTasks = tasks.filter((t) => t.user_id === userId);

  if (userTasks.length === 0) {
    await ctx.reply("No open tasks. Nice work!");
    return;
  }

  const lines = userTasks.map((t, i) => {
    const due = t.due_date ? ` (due ${t.due_date})` : "";
    return `${i + 1}. <b>${esc(t.title)}</b>${due}\n   └ ${esc(t.contacts.name)} · ${LOAN_TYPE_LABELS[t.contacts.loan_type]}`;
  });

  const kb = taskListKeyboard(userTasks, "done_task");

  await ctx.reply(`<b>Open tasks (${userTasks.length}):</b>\n\n${lines.join("\n\n")}`, {
    parse_mode: "HTML",
    reply_markup: kb,
  });
}

async function addFlow(ctx: Context, session: SessionData) {
  const userId = await requireUser(ctx);
  if (!userId) return;

  session.action = "add";
  session.userId = userId;
  session.step = "name";

  await ctx.reply("What's the contact's name?");
}

export async function handleList(ctx: Context) {
  const userId = await requireUser(ctx);
  if (!userId) return;

  const arg = (ctx.match as string | undefined)?.trim();

  const supabase = createServiceClient();
  let contacts = await getAllContacts(supabase);
  contacts = contacts.filter((c) => c.user_id === userId);

  if (arg && ALL_STAGES.includes(arg as AllStages)) {
    contacts = contacts.filter((c) => c.stage === arg);
  }

  if (contacts.length === 0) {
    await ctx.reply(arg ? `No contacts in ${STAGE_LABELS[arg as AllStages]}.` : "No contacts yet. Use /add to create one.");
    return;
  }

  const grouped = new Map<AllStages, typeof contacts>();
  for (const c of contacts) {
    if (!grouped.has(c.stage)) grouped.set(c.stage, []);
    grouped.get(c.stage)!.push(c);
  }

  const lines: string[] = [];
  for (const stage of ALL_STAGES) {
    const stageContacts = grouped.get(stage);
    if (!stageContacts) continue;
    lines.push(`\n<b>${STAGE_LABELS[stage]}</b>`);
    stageContacts.forEach((c) => {
      const extra = c.stage === "adverse" && c.adverse_reason
        ? ` (${ADVERSE_REASON_LABELS[c.adverse_reason]})`
        : "";
      lines.push(`  · ${esc(c.name)} — ${LOAN_TYPE_LABELS[c.loan_type]}${extra}`);
    });
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

async function moveFlow(ctx: Context, session: SessionData) {
  const userId = await requireUser(ctx);
  if (!userId) return;

  const supabase = createServiceClient();
  let contacts = await getAllContacts(supabase);
  contacts = contacts.filter((c) => c.user_id === userId);

  if (contacts.length === 0) {
    await ctx.reply("No contacts to move.");
    return;
  }

  session.action = "move";
  session.userId = userId;

  await ctx.reply("Pick a contact to move:", {
    reply_markup: contactListKeyboard(contacts, "move_contact"),
  });
}

async function taskFlow(ctx: Context, session: SessionData) {
  const userId = await requireUser(ctx);
  if (!userId) return;

  const supabase = createServiceClient();
  let contacts = await getAllContacts(supabase);
  contacts = contacts.filter((c) => c.user_id === userId);

  if (contacts.length === 0) {
    await ctx.reply("No contacts yet. Use /add first.");
    return;
  }

  session.action = "task";
  session.userId = userId;

  await ctx.reply("Pick a contact to add a task to:", {
    reply_markup: contactListKeyboard(contacts, "task_contact"),
  });
}

export async function handleDone(ctx: Context) {
  const userId = await requireUser(ctx);
  if (!userId) return;

  const supabase = createServiceClient();
  const tasks = await getOpenTasks(supabase);
  const userTasks = tasks.filter((t) => t.user_id === userId);

  if (userTasks.length === 0) {
    await ctx.reply("No open tasks!");
    return;
  }

  await ctx.reply("Pick a task to mark done:", {
    reply_markup: taskListKeyboard(userTasks, "done_task"),
  });
}

export async function handleDelete(ctx: Context) {
  const userId = await requireUser(ctx);
  if (!userId) return;

  const supabase = createServiceClient();
  let contacts = await getAllContacts(supabase);
  contacts = contacts.filter((c) => c.user_id === userId);

  if (contacts.length === 0) {
    await ctx.reply("No contacts to delete.");
    return;
  }

  await ctx.reply("Pick a contact to delete:", {
    reply_markup: contactListKeyboard(contacts, "delete_contact"),
  });
}

async function callbackFlow(ctx: Context, session: SessionData, clear: Clear) {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return;

  // Approval-card callbacks answer themselves and must be matched before the
  // contact-management flows below, which claim broad prefixes.
  if (await handleApprovalCallback(ctx, session)) return;
  // Workflow approval taps. Checked alongside the queue's own callbacks; the
  // two use distinct prefixes so neither can swallow the other's.
  if (await handleWorkflowCallback(ctx)) return;
  // Today card taps. Same reasoning: its own prefixes, answered before the
  // contact-management flows below, which claim broad ones like "stage:".
  if (await handleTodayCallback(ctx)) return;
  await ctx.answerCallbackQuery();

  const supabase = createServiceClient();
  const userId = await getUserIdByTelegramId(supabase, ctx.from.id);
  if (!userId) {
    await ctx.reply("You're not linked. Connect via the web app.");
    return;
  }


  if (data === "cancel") {
    clear();
    await ctx.editMessageText("Cancelled.");
    return;
  }

  // /add flow — loan type selection
  if (data.startsWith("lt:")) {
    const loanType = data.slice(3) as LoanType;
    session.loanType = loanType;
    session.step = "crm";
    await ctx.editMessageText(`Loan type: <b>${LOAN_TYPE_LABELS[loanType]}</b>\n\nPick CRM:`, {
      parse_mode: "HTML",
      reply_markup: crmKeyboard(),
    });
    return;
  }

  // /add flow — CRM selection
  if (data.startsWith("crm:")) {
    const crmVal = data.slice(4) as CRM;
    try {
      const contact = await createContact(supabase, {
        user_id: userId,
        name: session.name!,
        loan_type: session.loanType as LoanType,
        crm: crmVal,
      });
      clear();
      await ctx.editMessageText(
        `Contact added: <b>${esc(contact.name)}</b>\n${LOAN_TYPE_LABELS[contact.loan_type]} · ${STAGE_LABELS[contact.stage]}`,
        { parse_mode: "HTML" }
      );
    } catch {
      await ctx.editMessageText("Failed to create contact. Try again.");
      clear();
    }
    return;
  }

  // /move flow — contact selected
  if (data.startsWith("move_contact:")) {
    const contactId = data.slice(13);
    session.contactId = contactId;
    await ctx.editMessageText("Pick the new stage:", {
      reply_markup: stageKeyboard("move_stage"),
    });
    return;
  }

  // /move flow — stage selected
  if (data.startsWith("move_stage:")) {
    const newStage = data.slice(11) as AllStages;

    if (newStage === "adverse") {
      await ctx.editMessageText("Select the adverse reason:", {
        reply_markup: adverseReasonKeyboard(session.contactId!),
      });
      return;
    }

    try {
      const contact = await updateContact(supabase, session.contactId!, {
        stage: newStage,
        adverse_reason: null,
      });
      clear();
      await ctx.editMessageText(
        `<b>${esc(contact.name)}</b> moved to ${STAGE_LABELS[newStage]}`,
        { parse_mode: "HTML" }
      );
    } catch {
      await ctx.editMessageText("Failed to move contact.");
      clear();
    }
    return;
  }

  // /move flow — adverse reason selected
  if (data.startsWith("adverse_reason:")) {
    const parts = data.slice(15).split(":");
    const contactId = parts[0];
    const reason = parts[1] as AdverseReason;
    try {
      const contact = await updateContact(supabase, contactId, {
        stage: "adverse" as AllStages,
        adverse_reason: reason,
      });
      clear();
      await ctx.editMessageText(
        `<b>${esc(contact.name)}</b> moved to Adverse (${ADVERSE_REASON_LABELS[reason]})`,
        { parse_mode: "HTML" }
      );
    } catch {
      await ctx.editMessageText("Failed to move contact.");
      clear();
    }
    return;
  }

  // /task flow — contact selected
  if (data.startsWith("task_contact:")) {
    const contactId = data.slice(13);
    session.contactId = contactId;
    session.step = "task_title";
    await ctx.editMessageText("Enter the task title:");
    return;
  }

  // /done flow
  if (data.startsWith("done_task:")) {
    const taskId = data.slice(10);
    try {
      const task = await completeTask(supabase, taskId);
      await ctx.editMessageText(`Task "<b>${esc(task.title)}</b>" marked done!`, {
        parse_mode: "HTML",
      });
    } catch {
      await ctx.editMessageText("Failed to complete task.");
    }
    return;
  }

  // /delete flow — contact selected, confirm
  if (data.startsWith("delete_contact:")) {
    const contactId = data.slice(15);
    session.contactId = contactId;
    await ctx.editMessageText("Are you sure you want to delete this contact? This will also delete all their tasks.", {
      reply_markup: confirmKeyboard(contactId),
    });
    return;
  }

  // /delete flow — confirmed
  if (data.startsWith("confirm_delete:")) {
    const contactId = data.slice(15);
    try {
      await deleteContact(supabase, contactId);
      clear();
      await ctx.editMessageText("Contact deleted.");
    } catch {
      await ctx.editMessageText("Failed to delete contact.");
      clear();
    }
    return;
  }

  // /list filter by stage
  if (data.startsWith("stage:")) {
    const stage = data.slice(6) as PipelineStage;
    let contacts = await getAllContacts(supabase);
    contacts = contacts.filter((c) => c.user_id === userId && c.stage === stage);

    if (contacts.length === 0) {
      await ctx.editMessageText(`No contacts in ${STAGE_LABELS[stage]}.`);
      return;
    }

    const lines = contacts.map((c) => `  · ${esc(c.name)} — ${LOAN_TYPE_LABELS[c.loan_type]}`);
    await ctx.editMessageText(`<b>${STAGE_LABELS[stage]}</b>\n${lines.join("\n")}`, {
      parse_mode: "HTML",
    });
    return;
  }
}

async function textFlow(ctx: Context, session: SessionData, clear: Clear) {
  if (!ctx.from || !ctx.message?.text) return;

  // The reply that follows Edit on an approval card.
  if (await handleApprovalText(ctx, session, clear)) return;

  if (!session.action) return;

  const supabase = createServiceClient();
  const userId = await getUserIdByTelegramId(supabase, ctx.from.id);
  if (!userId) return;

  const text = ctx.message.text.trim();

  // /add flow — waiting for name
  if (session.action === "add" && session.step === "name") {
    session.name = text;
    session.step = "loan_type";
    await ctx.reply("Pick the loan type:", { reply_markup: loanTypeKeyboard() });
    return;
  }

  // /task flow — waiting for title
  if (session.action === "task" && session.step === "task_title") {
    try {
      const task = await createTask(supabase, {
        user_id: userId,
        contact_id: session.contactId!,
        title: text,
      });
      clear();
      await ctx.reply(
        `Task added: <b>${esc(task.title)}</b>\n└ ${esc(task.contacts.name)}`,
        { parse_mode: "HTML" }
      );
    } catch {
      await ctx.reply("Failed to add task. Try again.");
      clear();
    }
    return;
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Exported handlers
//
// Each loads its session before running and persists it afterwards, including
// on an early return — which these handlers do constantly.
// ---------------------------------------------------------------------------

export const handleAdd = inSession(addFlow);
export const handleMove = inSession(moveFlow);
export const handleTask = inSession(taskFlow);
export const handleCallbackQuery = inSession(callbackFlow);
export const handleTextMessage = inSession(textFlow);
