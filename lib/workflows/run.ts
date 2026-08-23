/**
 * Running workflows for one lead.
 *
 * Gathers facts, evaluates, records the run, and then either executes, queues
 * for approval, or does nothing — in that order, and never out of it.
 *
 * The run row is written BEFORE the action, not after. Two reasons, both
 * learned the hard way in systems like this:
 *
 *   - The unique index on (workflow_id, contact_id, occurrence_key) is the
 *     real idempotency guard. Claiming the occurrence first means two
 *     concurrent evaluations race on the insert, and the loser stops. Acting
 *     first and recording after means both act.
 *   - An action that throws still leaves a row explaining what was attempted.
 *     A crash that leaves no trace is indistinguishable from never having run.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateWorkflows, verifyStillValid } from "@/lib/workflows/evaluate";
import { executeAction } from "@/lib/workflows/execute";
import type { LeadFacts, Workflow } from "@/lib/workflows/types";
import {
  getMortgageFields,
  isInbound,
  isOptedOut,
  isOutbound,
  type BonzoProspect,
} from "@/lib/bonzo/client";
import type { AllStages, Contact, LoanType } from "@/types/db";
import { STAGE_LABELS, LOAN_TYPE_LABELS } from "@/types/db";
import type { LeadState } from "@/lib/insights/lead-state";

export interface RunResult {
  ran: boolean;
  status?: string;
  workflowName?: string;
  summary: string;
}

/** Parses a Bonzo loan amount, which arrives as a formatted string. */
export function parseLoanAmount(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Assembles the facts evaluation needs from a contact and its cache row. */
export function buildFacts(input: {
  contact: Contact;
  prospect: BonzoProspect | null;
  communications: { direction: string; created_at: string }[];
  leadState: LeadState | null;
  leadStateAt: string | null;
  previousStage: AllStages | null;
  hasNewInbound: boolean;
}): LeadFacts {
  const { contact, prospect, communications } = input;

  const latest = (match: (d: string) => boolean): string | null => {
    const times = communications
      .filter((c) => match(c.direction))
      .map((c) => new Date(c.created_at).getTime())
      .filter((t) => Number.isFinite(t));
    return times.length ? new Date(Math.max(...times)).toISOString() : null;
  };

  const mf = getMortgageFields(prospect);

  return {
    contactId: contact.id,
    stage: contact.stage,
    loanType: contact.loan_type,
    stageChangedAt: (contact as Contact & { stage_changed_at?: string | null }).stage_changed_at ?? null,
    previousStage: input.previousStage,
    lastInboundAt: latest(isInbound),
    lastOutboundAt: latest(isOutbound),
    hasNewInbound: input.hasNewInbound,
    leadState: input.leadState,
    leadStateAt: input.leadStateAt,
    // Any channel opted out bars a campaign handoff: enrolment does not let us
    // choose which channel the sequence will use.
    optedOut:
      isOptedOut(prospect, "sms") ||
      isOptedOut(prospect, "email") ||
      prospect?.do_not_call === true,
    loanAmount: parseLoanAmount(mf?.loan_amount),
  };
}

/** Plain-English description of an action, for the approval card. */
export function describeAction(
  workflow: Workflow,
  campaignName?: string | null
): string {
  const cfg = workflow.action_config ?? {};
  switch (workflow.action_type) {
    case "add_to_bonzo_campaign":
      return `Move to Bonzo campaign ${campaignName ?? cfg.campaign_id}`;
    case "move_stage":
      return `Move to ${STAGE_LABELS[cfg.stage as AllStages] ?? cfg.stage}`;
    case "mark_adverse":
      return `Mark adverse (${cfg.reason})`;
    case "notify_telegram":
      return String(cfg.message ?? "Send a note");
    case "create_task":
      return `Create task: ${cfg.title}`;
    case "queue_follow_up":
      return "Put a card in the daily queue";
  }
}

/**
 * Evaluates and acts for one contact.
 *
 * `now` is injectable so the whole path can be tested without waiting a day.
 */
export async function runWorkflowsForContact(input: {
  supabase: SupabaseClient;
  userId: string;
  contact: Contact;
  facts: LeadFacts;
  now?: Date;
}): Promise<RunResult> {
  const { supabase, userId, contact, facts } = input;
  const now = input.now ?? new Date();

  const [{ data: workflows }, { data: settings }] = await Promise.all([
    supabase
      .from("workflows")
      .select("*")
      .eq("user_id", userId)
      .eq("enabled", true)
      .order("priority", { ascending: true }),
    supabase
      .from("user_settings")
      .select("workflows_enabled")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  const list = (workflows ?? []) as Workflow[];
  if (list.length === 0) return { ran: false, summary: "no enabled workflows" };

  // Occurrences already recorded for this contact, so a repeat evaluation of
  // an unchanged lead does not attempt a doomed insert.
  const { data: priorRuns } = await supabase
    .from("workflow_runs")
    .select("workflow_id, occurrence_key")
    .eq("contact_id", contact.id);

  const firedOccurrences = new Map<string, Set<string>>();
  for (const r of priorRuns ?? []) {
    const set = firedOccurrences.get(r.workflow_id) ?? new Set<string>();
    set.add(r.occurrence_key);
    firedOccurrences.set(r.workflow_id, set);
  }

  const outcome = evaluateWorkflows({
    workflows: list,
    facts,
    workflowsEnabled: settings?.workflows_enabled ?? true,
    firedOccurrences,
    now,
  });

  if (!outcome.fired) return { ran: false, summary: outcome.reason };

  const { workflow, match, plannedStatus } = outcome;

  /*
   * Claim the occurrence first. A unique-violation here means another
   * evaluation got there first, which is a success for the guardrail rather
   * than an error worth surfacing.
   */
  const { data: run, error: insertErr } = await supabase
    .from("workflow_runs")
    .insert({
      workflow_id: workflow.id,
      contact_id: contact.id,
      status: plannedStatus,
      occurrence_key: match.occurrenceKey,
      trigger_snapshot: {
        ...match.snapshot,
        evaluated_stage: facts.stage,
        considered: outcome.considered,
      },
    })
    .select("id")
    .single();

  if (insertErr) {
    const duplicate = insertErr.code === "23505";
    return {
      ran: false,
      summary: duplicate
        ? "another evaluation claimed this occurrence first"
        : `could not record run: ${insertErr.message}`,
    };
  }

  // Dry-run stops here, having recorded exactly what it would have done.
  if (plannedStatus === "dry_run") {
    return {
      ran: true,
      status: "dry_run",
      workflowName: workflow.name,
      summary: `dry run: would ${describeAction(workflow)} for ${contact.name}`,
    };
  }

  if (plannedStatus === "pending_approval") {
    const { pushWorkflowApproval } = await import("@/lib/telegram/workflow-card");
    await pushWorkflowApproval(supabase, userId, {
      runId: run.id,
      contactName: contact.name,
      loanTypeLabel: LOAN_TYPE_LABELS[contact.loan_type as LoanType] ?? contact.loan_type,
      bonzoProspectId: contact.bonzo_prospect_id,
      workflowName: workflow.name,
      actionDescription: describeAction(workflow),
      why: match.reason ?? summariseSnapshot(match.snapshot),
      displacing: null,
    }).catch(() => ({ pushed: false }));

    return {
      ran: true,
      status: "pending_approval",
      workflowName: workflow.name,
      summary: `awaiting approval for ${contact.name}`,
    };
  }

  /*
   * 4.4: re-check at execution time, not just evaluation time. Nothing has
   * moved in this path yet, but the same call is what protects the approval
   * path, where hours can pass between the card and the tap.
   */
  const stillValid = verifyStillValid(facts, facts.stage);
  if (!stillValid.ok) {
    await supabase
      .from("workflow_runs")
      .update({ status: "skipped", error: stillValid.reason })
      .eq("id", run.id);
    return { ran: false, summary: `skipped: ${stillValid.reason}` };
  }

  const result = await executeAction({ supabase, workflow, contact, plannedStatus });

  await supabase
    .from("workflow_runs")
    .update(
      result.ok
        ? { status: "executed", displaced: result.displaced ?? null }
        : { status: "failed", error: result.error }
    )
    .eq("id", run.id);

  return {
    ran: true,
    status: result.ok ? "executed" : "failed",
    workflowName: workflow.name,
    summary: result.ok ? result.summary : `failed: ${result.error}`,
  };
}

/** One readable line from a trigger snapshot, for the approval card. */
export function summariseSnapshot(snapshot: Record<string, unknown>): string {
  if (typeof snapshot.days_since_inbound === "number") {
    return `No reply for ${snapshot.days_since_inbound} days`;
  }
  if (typeof snapshot.days_in_stage === "number") {
    return `${snapshot.days_in_stage} days in ${snapshot.stage}`;
  }
  if (typeof snapshot.days_since_outbound === "number") {
    return `Not messaged for ${snapshot.days_since_outbound} days`;
  }
  if (snapshot.from && snapshot.to) {
    return `Moved ${snapshot.from} → ${snapshot.to}`;
  }
  if (snapshot.field) {
    return `Classifier: ${snapshot.field} is ${String(snapshot.actual)}`;
  }
  return "Trigger fired";
}
