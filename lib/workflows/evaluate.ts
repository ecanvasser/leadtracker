/**
 * Workflow evaluation (spec 4.4).
 *
 * A pure function from workflows plus facts to at most one decision. Nothing
 * here touches the database, Bonzo, or the model — which is the point: the
 * guardrails below are the part that can quietly ruin a client relationship,
 * so they are testable exhaustively without any of that.
 *
 * The guardrails, in the order they apply:
 *
 *   1. Kill switch. workflows_enabled halts everything at once.
 *   2. Hard stops. A lead that is adverse, funded, opted out, or no longer in
 *      an automated stage is not touched by any workflow, whatever matched.
 *   3. Priority order, first match wins. One action per lead per evaluation,
 *      so a quiet lead cannot land in three campaigns.
 *   4. Idempotency. A workflow fires at most once per contact per trigger
 *      occurrence; already-seen occurrences are skipped.
 *   5. Opt-out re-check before any action that causes a message.
 *
 * Rule 2 is re-applied at execution time by `verifyStillValid`, not only here.
 * Evaluation and execution are separated by a queue, and a lead can convert in
 * between — that is exactly when acting is most damaging.
 */

import { isQueueEligible, type AllStages } from "@/types/db";
import { matchTrigger, type TriggerMatch } from "@/lib/workflows/triggers";
import type { ActionType, LeadFacts, Workflow } from "@/lib/workflows/types";
import { needsApproval, workflowMode } from "@/lib/workflows/types";

/** Actions that cause a message to reach the prospect. */
export const MESSAGE_CAUSING_ACTIONS: readonly ActionType[] = [
  // A campaign handoff enrols them in a live sequence. It is a send.
  "add_to_bonzo_campaign",
];

export function causesMessage(action: ActionType): boolean {
  return MESSAGE_CAUSING_ACTIONS.includes(action);
}

export type EvaluationOutcome =
  | { fired: false; reason: string; considered: ConsideredWorkflow[] }
  | {
      fired: true;
      workflow: Workflow;
      match: TriggerMatch;
      /** dry_run writes a row and does nothing else. */
      plannedStatus: "dry_run" | "pending_approval" | "executed";
      considered: ConsideredWorkflow[];
    };

/** One workflow's fate in this evaluation, for dry-run output and auditing. */
export interface ConsideredWorkflow {
  workflowId: string;
  name: string;
  priority: number;
  outcome: "fired" | "no_match" | "condition_failed" | "already_fired" | "not_reached" | "off";
  reason?: string;
}

export interface EvaluateInput {
  workflows: Workflow[];
  facts: LeadFacts;
  /** Kill switch: user_settings.workflows_enabled. */
  workflowsEnabled: boolean;
  /**
   * Occurrence keys already recorded for this contact, keyed by workflow id.
   * The caller reads these from workflow_runs; the unique index is the real
   * guard, this is the cheap one that avoids a doomed insert.
   */
  firedOccurrences: Map<string, Set<string>>;
  now: Date;
}

/**
 * Hard stops (4.4).
 *
 * Deliberately a separate exported function so execution can re-run exactly
 * the same check against freshly-read facts rather than a near-copy that
 * drifts from this one.
 */
export function hardStopReason(facts: LeadFacts): string | null {
  if (facts.optedOut) return "lead is opted out or DNC";
  if (facts.stage === "adverse") return "lead is adverse";
  if (facts.stage === "funded") return "lead is funded";
  if (!isQueueEligible(facts.stage)) {
    return `stage ${facts.stage} is not automated`;
  }
  return null;
}

/**
 * Re-check at execution time (4.4).
 *
 * `expectedStage` is the stage recorded when the workflow was evaluated. A
 * lead who moved to App In since then has converted, and D4 makes that the
 * signal to stop — acting now would hand a live deal to a cold campaign.
 */
export function verifyStillValid(
  facts: LeadFacts,
  expectedStage: AllStages
): { ok: true } | { ok: false; reason: string } {
  /*
   * Stage drift is checked before the generic hard stops, because when a lead
   * converts both are true and the stage-change explanation is the one worth
   * reading six weeks later. "stage app_in is not automated" describes the
   * rule; "quoted_follow_up -> app_in between evaluation and execution"
   * describes what actually happened to the deal.
   */
  if (facts.stage !== expectedStage) {
    return {
      ok: false,
      reason: `stage changed ${expectedStage} -> ${facts.stage} between evaluation and execution`,
    };
  }
  const stop = hardStopReason(facts);
  if (stop) return { ok: false, reason: stop };
  return { ok: true };
}

/** Optional filters, applied only after the trigger has matched. */
export function conditionsPass(
  workflow: Workflow,
  facts: LeadFacts
): { pass: true } | { pass: false; reason: string } {
  const c = workflow.conditions ?? {};

  if (c.loan_type?.length && !c.loan_type.includes(facts.loanType)) {
    return { pass: false, reason: `loan type ${facts.loanType} not in filter` };
  }
  if (c.stage?.length && !c.stage.includes(facts.stage)) {
    return { pass: false, reason: `stage ${facts.stage} not in filter` };
  }
  if (c.min_loan_amount != null) {
    if (facts.loanAmount == null) {
      return { pass: false, reason: "loan amount unknown, minimum required" };
    }
    if (facts.loanAmount < c.min_loan_amount) {
      return { pass: false, reason: `loan amount below ${c.min_loan_amount}` };
    }
  }
  /*
   * D4. A whitelist, and an unclassified lead fails it.
   *
   * That asymmetry is deliberate. The only rule carrying this condition is
   * the handoff, and firing it on a lead whose reaction to the quote has
   * never been read would be acting on an absence of evidence in the one
   * direction the spec says is worse. A lead in Quoted – Follow Up is
   * classified twice a day, so a null here means something is wrong rather
   * than that the lead is quiet — and the right response to that is to leave
   * the lead for Eddie.
   */
  if (c.pitch_response?.length) {
    const actual = facts.leadState?.pitch_response;
    if (!actual) {
      return { pass: false, reason: "lead has no classification yet" };
    }
    if (!c.pitch_response.includes(actual)) {
      return { pass: false, reason: `pitch response ${actual} is not in the firing set` };
    }
  }
  if (c.max_loan_amount != null) {
    if (facts.loanAmount == null) {
      return { pass: false, reason: "loan amount unknown, maximum required" };
    }
    if (facts.loanAmount > c.max_loan_amount) {
      return { pass: false, reason: `loan amount above ${c.max_loan_amount}` };
    }
  }
  return { pass: true };
}

/**
 * Evaluates every workflow for one lead and returns at most one decision.
 *
 * Ties on priority are broken by created_at then id, so evaluation is
 * deterministic. Two workflows at priority 100 that both match must not
 * alternate between runs — that would make dry-run observation worthless,
 * since what Eddie watched for three days would not be what later fires.
 */
export function evaluateWorkflows(input: EvaluateInput): EvaluationOutcome {
  const { facts, workflowsEnabled, firedOccurrences, now } = input;
  const considered: ConsideredWorkflow[] = [];

  if (!workflowsEnabled) {
    return { fired: false, reason: "workflows are paused (kill switch)", considered };
  }

  const stop = hardStopReason(facts);
  if (stop) return { fired: false, reason: stop, considered };

  const ordered = [...input.workflows].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const byCreated = a.created_at.localeCompare(b.created_at);
    return byCreated !== 0 ? byCreated : a.id.localeCompare(b.id);
  });

  for (const workflow of ordered) {
    if (workflowMode(workflow) === "off") {
      considered.push({
        workflowId: workflow.id,
        name: workflow.name,
        priority: workflow.priority,
        outcome: "off",
      });
      continue;
    }

    const match = matchTrigger(workflow, facts, now);
    if (!match.matched) {
      considered.push({
        workflowId: workflow.id,
        name: workflow.name,
        priority: workflow.priority,
        outcome: "no_match",
        reason: match.reason,
      });
      continue;
    }

    const cond = conditionsPass(workflow, facts);
    if (!cond.pass) {
      considered.push({
        workflowId: workflow.id,
        name: workflow.name,
        priority: workflow.priority,
        outcome: "condition_failed",
        reason: cond.reason,
      });
      continue;
    }

    // Idempotency: this workflow already fired on this occasion.
    if (firedOccurrences.get(workflow.id)?.has(match.occurrenceKey)) {
      considered.push({
        workflowId: workflow.id,
        name: workflow.name,
        priority: workflow.priority,
        outcome: "already_fired",
        reason: match.occurrenceKey,
      });
      continue;
    }

    /*
     * Opt-out is checked in hardStopReason above, before any workflow is
     * considered. Re-asserted here because this is the branch that commits to
     * an action, and a message-causing action reaching an opted-out lead is
     * the one failure with legal weight rather than merely commercial.
     */
    if (causesMessage(workflow.action_type) && facts.optedOut) {
      considered.push({
        workflowId: workflow.id,
        name: workflow.name,
        priority: workflow.priority,
        outcome: "condition_failed",
        reason: "opted out; message-causing action refused",
      });
      continue;
    }

    considered.push({
      workflowId: workflow.id,
      name: workflow.name,
      priority: workflow.priority,
      outcome: "fired",
    });

    // Everything after the winner is recorded as unreached, so a dry-run
    // summary shows what was suppressed by first-match-wins rather than
    // leaving Eddie to infer it.
    for (const rest of ordered.slice(ordered.indexOf(workflow) + 1)) {
      considered.push({
        workflowId: rest.id,
        name: rest.name,
        priority: rest.priority,
        outcome: "not_reached",
      });
    }

    const mode = workflowMode(workflow);
    return {
      fired: true,
      workflow,
      match,
      plannedStatus:
        mode === "dry_run"
          ? "dry_run"
          : needsApproval(workflow)
            ? "pending_approval"
            : "executed",
      considered,
    };
  }

  return { fired: false, reason: "no workflow matched", considered };
}
