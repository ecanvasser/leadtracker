/**
 * Telegram handlers for workflow approval, and the kill switch.
 *
 * The approval tap is where D2's "ask me first" actually happens, and it is
 * the last point before a client is messaged. Everything the evaluation-time
 * guardrails checked is re-checked here against freshly-read state, because
 * hours can pass between the card being pushed and Eddie tapping Send — and
 * the most likely thing to happen in those hours is the lead replying, which
 * is exactly when handing them to a cold campaign is worst.
 */

import type { Context } from "grammy";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/service";
import { getUserIdByTelegramId } from "@/lib/db/telegram";
import { WF_CB, revertKeyboard } from "@/lib/telegram/workflow-card";
import { escapeHtml } from "@/lib/telegram/approval-card";
import { executeAction, revertAction } from "@/lib/workflows/execute";
import { verifyStillValid } from "@/lib/workflows/evaluate";
import { buildFacts } from "@/lib/workflows/run";
import { getCommunicationHistory, getProspect } from "@/lib/bonzo/client";
import type { Workflow } from "@/lib/workflows/types";
import type { AllStages, Contact } from "@/types/db";

export function parseWorkflowCallback(
  data: string | undefined
): { action: string; runId: string } | null {
  if (!data) return null;
  const [action, runId] = data.split(":");
  if (!action || !runId) return null;
  if (!Object.values(WF_CB).includes(action as never)) return null;
  return { action, runId };
}

export function isWorkflowCallback(data: string | undefined): boolean {
  return parseWorkflowCallback(data) !== null;
}

/** Loads a run with its workflow and contact, or null. */
async function loadRun(supabase: SupabaseClient, runId: string, userId: string) {
  const { data: run } = await supabase
    .from("workflow_runs")
    .select("*, workflows(*), contacts(*)")
    .eq("id", runId)
    .maybeSingle();

  if (!run) return null;
  const workflow = run.workflows as unknown as Workflow;
  const contact = run.contacts as unknown as Contact;
  if (!workflow || !contact || workflow.user_id !== userId) return null;
  return { run, workflow, contact };
}

export async function handleWorkflowCallback(ctx: Context): Promise<boolean> {
  const parsed = parseWorkflowCallback(ctx.callbackQuery?.data);
  if (!parsed || !ctx.from) return false;

  const supabase = createServiceClient();
  const userId = await getUserIdByTelegramId(supabase, ctx.from.id);
  if (!userId) {
    await ctx.answerCallbackQuery({ text: "Account not linked." });
    return true;
  }

  const loaded = await loadRun(supabase, parsed.runId, userId);
  if (!loaded) {
    await ctx.answerCallbackQuery({ text: "That workflow run is gone." });
    return true;
  }
  const { run, workflow, contact } = loaded;

  if (parsed.action === WF_CB.skip) {
    await supabase
      .from("workflow_runs")
      .update({ status: "skipped", error: "skipped from Telegram" })
      .eq("id", run.id);
    await ctx.answerCallbackQuery({ text: "Skipped." });
    await finish(ctx, "⏭ Skipped.");
    return true;
  }

  if (parsed.action === WF_CB.revert) {
    const result = await revertAction({
      supabase,
      workflow,
      contact,
      displaced: run.displaced as Record<string, unknown> | null,
    });
    await ctx.answerCallbackQuery({ text: result.ok ? "Undone." : "Could not undo." });
    await finish(
      ctx,
      result.ok ? `↩️ ${escapeHtml(result.summary)}` : `⚠️ ${escapeHtml(result.error)}`
    );
    return true;
  }

  // --- Approve ------------------------------------------------------------

  if (run.status !== "pending_approval") {
    await ctx.answerCallbackQuery({ text: `Already ${String(run.status).replace(/_/g, " ")}.` });
    return true;
  }

  // Claim before acting, so a double-tap loses the race rather than sending
  // twice. The status filter is the claim.
  const { data: claimed } = await supabase
    .from("workflow_runs")
    .update({ status: "executed" })
    .eq("id", run.id)
    .eq("status", "pending_approval")
    .select("id")
    .maybeSingle();

  if (!claimed) {
    await ctx.answerCallbackQuery({ text: "Already handled." });
    return true;
  }

  await ctx.answerCallbackQuery({ text: "Working…" });

  /*
   * Re-read everything. The card may have been sitting on Eddie's phone for
   * hours; the guardrails have to run against what is true now, not what was
   * true when it was pushed. `evaluated_stage` is the stage recorded at
   * evaluation, and a lead who has moved since has converted or been parked.
   */
  const prospect = contact.bonzo_prospect_id
    ? await getProspect(contact.bonzo_prospect_id).catch(() => null)
    : null;
  const comms = contact.bonzo_prospect_id
    ? await getCommunicationHistory(contact.bonzo_prospect_id).catch(() => [])
    : [];

  const { data: freshContact } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", contact.id)
    .maybeSingle();

  const current = (freshContact ?? contact) as Contact;

  const facts = buildFacts({
    contact: current,
    prospect,
    communications: comms,
    leadState: null,
    leadStateAt: null,
    previousStage: null,
    hasNewInbound: false,
  });

  const expected =
    ((run.trigger_snapshot as Record<string, unknown>)?.evaluated_stage as AllStages) ??
    current.stage;

  const stillValid = verifyStillValid(facts, expected);
  if (!stillValid.ok) {
    await supabase
      .from("workflow_runs")
      .update({ status: "skipped", error: stillValid.reason })
      .eq("id", run.id);
    await finish(ctx, `⏭ Skipped — ${escapeHtml(stillValid.reason)}`);
    return true;
  }

  const result = await executeAction({
    supabase,
    workflow,
    contact: current,
    plannedStatus: "executed",
  });

  await supabase
    .from("workflow_runs")
    .update(
      result.ok
        ? { status: "executed", displaced: result.displaced ?? null }
        : { status: "failed", error: result.error }
    )
    .eq("id", run.id);

  if (!result.ok) {
    await finish(ctx, `⚠️ ${escapeHtml(result.error)}`);
    return true;
  }

  // An undo button, while it is still cheap. Only offered where reverting
  // actually restores something.
  const revertible =
    workflow.action_type === "add_to_bonzo_campaign" ||
    workflow.action_type === "move_stage" ||
    workflow.action_type === "mark_adverse";

  await finish(
    ctx,
    `✅ ${escapeHtml(result.summary)}`,
    revertible && result.displaced ? revertKeyboard(run.id) : undefined
  );
  return true;
}

/** Replaces the card with its outcome, so no live button is left on screen. */
async function finish(
  ctx: Context,
  text: string,
  keyboard?: ReturnType<typeof revertKeyboard>
): Promise<void> {
  try {
    await ctx.editMessageText(`${ctx.callbackQuery?.message?.text ?? ""}\n\n${text}`, {
      parse_mode: "HTML",
      reply_markup: keyboard ?? { inline_keyboard: [] },
    });
  } catch {
    // Editing fails on an old or unchanged message; the outcome still stands.
  }
}

/**
 * /pause and /resume — the 4.4 kill switch.
 *
 * Global and immediate. Individual workflow states are left alone, so
 * resuming restores exactly what was configured rather than requiring Eddie to
 * remember which were live.
 */
export async function handlePause(ctx: Context): Promise<void> {
  await setKillSwitch(ctx, false);
}

export async function handleResume(ctx: Context): Promise<void> {
  await setKillSwitch(ctx, true);
}

async function setKillSwitch(ctx: Context, enabled: boolean): Promise<void> {
  if (!ctx.from) return;
  const supabase = createServiceClient();
  const userId = await getUserIdByTelegramId(supabase, ctx.from.id);
  if (!userId) {
    await ctx.reply("Account not linked. Send /start first.");
    return;
  }

  const { error } = await supabase
    .from("user_settings")
    .upsert({ user_id: userId, workflows_enabled: enabled }, { onConflict: "user_id" });

  if (error) {
    await ctx.reply("Could not change that. Try again.");
    return;
  }

  await ctx.reply(
    enabled
      ? "▶️ Workflows resumed. Each one goes back to whatever state it was in."
      : "⏸ Workflows paused. Nothing will fire until you send /resume."
  );
}
