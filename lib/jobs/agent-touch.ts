/**
 * agent_touch — drafts one step of a deployed agent's plan.
 *
 * Structurally the same job as draft_quoted, and deliberately so: fresh Bonzo
 * read, re-decide on what comes back, budget gate, one model call, a
 * daily_queue row, the same Telegram approval card. What differs is only what
 * the draft is about.
 *
 * It does not send. Deploying an agent is consent to draft, not to send, and
 * every touch still waits for a tap.
 */

import { draftOne } from "@/lib/ai/draft-one";
import { recordModelUsage, withinBudget } from "@/lib/ai/usage";
import {
  getCommunicationHistory,
  getMortgageFields,
  getProspect,
  isInbound,
  isOptedOut,
  isOutbound,
  messagesOnly,
  type BonzoCommunication,
  type BonzoProspect,
} from "@/lib/bonzo/client";
import { readDraftSettings } from "@/lib/jobs/draft-quoted";
import { touchDue } from "@/lib/agents/schedule";
import {
  AGENT_DRAFT_ACTION,
  AGENT_TOUCH_REASON,
  HYPOTHESIS_LABELS,
  type AgentPlan,
  type ContactAgent,
  type Hypothesis,
} from "@/lib/agents/types";
import type { JobHandler } from "@/lib/jobs/handlers";
import { localDate } from "@/lib/time";
import type { LeadState } from "@/lib/insights/lead-state";

/** Ends a touch without ending the agent. */
async function settleTouch(
  supabase: Parameters<JobHandler>[0],
  touchId: string,
  status: "skipped" | "cancelled",
  note: string
): Promise<void> {
  await supabase
    .from("contact_agent_touches")
    .update({ status, note, settled_at: new Date().toISOString() })
    .eq("id", touchId);
}

export const agentTouch: JobHandler = async (supabase, job) => {
  const touchId = (job.payload as { touch_id?: string } | null)?.touch_id;
  if (!touchId) throw new Error("agent_touch requires a touch_id in the payload");

  const { data: touch } = await supabase
    .from("contact_agent_touches")
    .select("id, agent_id, user_id, contact_id, step_index, due_at, status")
    .eq("id", touchId)
    .maybeSingle();

  if (!touch) return { summary: "touch gone", usedModel: false };
  if (touch.status !== "pending") {
    return { summary: `touch already ${touch.status}`, usedModel: false };
  }

  const [{ data: agent }, { data: contact }] = await Promise.all([
    supabase
      .from("contact_agents")
      .select("id, status, context, goal, plan, activated_at")
      .eq("id", touch.agent_id)
      .maybeSingle(),
    supabase
      .from("contacts")
      .select("id, user_id, name, loan_type, stage, bonzo_prospect_id")
      .eq("id", touch.contact_id)
      .maybeSingle(),
  ]);

  if (!agent || !contact) {
    return { summary: "agent or contact gone", usedModel: false };
  }

  const plan = (agent.plan ?? { summary: "", steps: [] }) as AgentPlan;
  const step = plan.steps.find((s) => s.step === touch.step_index);
  if (!step) {
    await settleTouch(supabase, touchId, "cancelled", "no matching step in the plan");
    return { summary: "no matching plan step", usedModel: false };
  }

  const settings = await readDraftSettings(supabase, contact.user_id);

  /*
   * Drafting Off switches agents off too.
   *
   * An agent is a drafting feature, and the master switch has to mean what it
   * says — a broker who turns drafting off and still gets agent messages has
   * been lied to by a control.
   */
  if (settings.mode === "off") {
    return { summary: "drafting is off; agent touch deferred", usedModel: false };
  }

  const { data: cache } = await supabase
    .from("insights_cache")
    .select("lead_state, bonzo_prospect_data")
    .eq("contact_id", contact.id)
    .maybeSingle();

  const { data: pending } = await supabase
    .from("daily_queue")
    .select("id")
    .eq("contact_id", contact.id)
    .eq("status", "pending")
    .limit(1);

  const { data: generated } = await supabase
    .from("outreach_log")
    .select("created_at")
    .eq("contact_id", contact.id)
    .eq("action_type", AGENT_DRAFT_ACTION)
    .order("created_at", { ascending: false });

  /*
   * Read Bonzo before deciding, not after.
   *
   * Same reasoning as draft_quoted: the cache is up to fifteen minutes stale,
   * which is fine for noticing a lead and not fine for writing to them. Here
   * it matters more — an agent touch is scheduled days in advance, so the
   * conversation has had far longer to move on than a quoted-window draft's
   * has.
   */
  if (!contact.bonzo_prospect_id) {
    await settleTouch(supabase, touchId, "cancelled", "lead is not linked to Bonzo");
    return { summary: "no linked Bonzo prospect", usedModel: false };
  }

  const [communications, prospect] = await Promise.all([
    getCommunicationHistory(contact.bonzo_prospect_id),
    getProspect(contact.bonzo_prospect_id),
  ]);

  const messages = messagesOnly(communications);
  const newest = (match: (d: string) => boolean): string | null => {
    const times = messages
      .filter((c) => match(c.direction))
      .map((c) => new Date(c.created_at).getTime())
      .filter((t) => Number.isFinite(t));
    return times.length ? new Date(Math.max(...times)).toISOString() : null;
  };
  const lastInbound = newest(isInbound);
  const lastOutbound = newest(isOutbound);
  const lastMessage =
    [lastInbound, lastOutbound].filter((v): v is string => v !== null).sort().at(-1) ?? null;

  await supabase
    .from("insights_cache")
    .update({
      bonzo_communication: communications,
      last_message_at: lastMessage,
      last_inbound_at: lastInbound,
      last_outbound_at: lastOutbound,
      last_synced_at: new Date().toISOString(),
    })
    .eq("contact_id", contact.id);

  const due = touchDue({
    agentStatus: agent.status as ContactAgent["status"],
    touchStatus: "pending",
    dueAt: touch.due_at as string,
    activatedAt: agent.activated_at as string | null,
    lastMessageAt: lastMessage,
    lastInboundAt: lastInbound,
    minHoursSinceLastMessage: settings.minHoursSinceLastMessage,
    hasPendingCard: (pending ?? []).length > 0,
    draftsGenerated: (generated ?? []).map((r) => r.created_at as string),
    now: new Date(),
    timeZone: settings.timeZone,
  });

  if (!due.due) {
    /*
     * Deferred, not cancelled. The touch stays pending and the next tick tries
     * again — a lead who is merely too recently messaged should get this touch
     * tomorrow, not lose it. The reply case is different, and the refresh path
     * pauses the whole agent for that.
     */
    await supabase
      .from("contact_agent_touches")
      .update({ note: `deferred: ${due.reason}` })
      .eq("id", touchId);
    return { summary: `touch not due: ${due.reason}`, usedModel: false };
  }

  const resolvedProspect = (prospect ??
    (cache?.bonzo_prospect_data as BonzoProspect | null) ??
    null) as BonzoProspect | null;

  if (
    resolvedProspect &&
    (isOptedOut(resolvedProspect, "sms") ||
      isOptedOut(resolvedProspect, "email") ||
      resolvedProspect.do_not_call === true)
  ) {
    // Cancels the touch and leaves the agent for Eddie to retire deliberately;
    // an opt-out is a fact about the lead, not a fault in his plan.
    await settleTouch(supabase, touchId, "cancelled", "the lead is opted out");
    return { summary: "prospect is opted out; no draft", usedModel: false };
  }

  if (getMortgageFields(resolvedProspect) === null) {
    await settleTouch(supabase, touchId, "cancelled", "no loan file to draft from");
    return { summary: "no loan file; refusing to draft from nothing", usedModel: false };
  }

  const budget = await withinBudget(supabase, contact.user_id);
  if (!budget.ok) {
    // Left pending on purpose: the budget resets tomorrow and the touch is
    // still worth making then.
    await supabase
      .from("contact_agent_touches")
      .update({ note: "deferred: over the daily token budget" })
      .eq("id", touchId);
    return { summary: "over daily token budget; no draft", usedModel: false };
  }

  const result = await draftOne({
    channel: "sms",
    contactName: contact.name,
    brokerName: settings.brokerName,
    brokerCompany: settings.brokerCompany,
    prospect: resolvedProspect,
    communications: communications as BonzoCommunication[],
    leadState: (cache?.lead_state as LeadState | null) ?? null,
    hoursSincePitch: null,
    agent: {
      brief: agent.context as string,
      angle: step.angle,
      hypothesis: HYPOTHESIS_LABELS[step.hypothesis as Hypothesis] ?? "unclear",
      stepNumber: step.step,
      totalSteps: plan.steps.length,
    },
  });

  for (const usage of result.usage) {
    await recordModelUsage(
      supabase,
      { userId: contact.user_id, purpose: "draft_quoted", contactId: contact.id },
      usage
    );
  }

  await supabase.from("outreach_log").insert({
    user_id: contact.user_id,
    contact_id: contact.id,
    action_type: AGENT_DRAFT_ACTION,
    status: result.validated ? "drafted" : "drafted_unvalidated",
    draft_message: result.body,
  });

  const { data: queued, error: queueErr } = await supabase
    .from("daily_queue")
    .insert({
      user_id: contact.user_id,
      contact_id: contact.id,
      queue_date: localDate(new Date(), settings.timeZone),
      // Below an unanswered reply, above the scheduled cadence. An agent touch
      // is planned work, not a response to something that just happened.
      priority_rank: 5,
      priority_reason: AGENT_TOUCH_REASON,
      action_type: "sms",
      status: "pending",
      lane: "agent",
      draft_message: result.body,
      agent_touch_id: touchId,
      unvalidated_reasons: result.validated
        ? null
        : result.violations.map((v) => v.detail),
      decision_trace: {
        lane: "agent",
        agent_id: agent.id,
        step: step.step,
        hypothesis: step.hypothesis,
        angle: step.angle,
      },
    })
    .select("id")
    .single();

  if (queueErr) throw queueErr;

  await supabase
    .from("contact_agent_touches")
    .update({
      status: "drafted",
      queue_item_id: queued.id,
      drafted_at: new Date().toISOString(),
      note: null,
    })
    .eq("id", touchId);

  const { pushCard } = await import("@/lib/telegram/push");
  const push = await pushCard(supabase, contact.user_id, queued.id);

  return {
    summary:
      `agent touch ${step.step}/${plan.steps.length} drafted for ${contact.name}` +
      (settings.mode === "dry_run" ? " (dry run)" : "") +
      (result.validated ? "" : ` — unvalidated: ${result.violations.length} issues`) +
      (push.pushed ? "; pushed" : `; not pushed (${push.reason})`),
    usedModel: true,
  };
};
