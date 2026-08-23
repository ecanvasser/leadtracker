/**
 * Workflow builder types (spec section 4).
 *
 * Eddie configures rules; the app evaluates them. The point of this layer over
 * "days elapsed", which Bonzo can already do by itself, is that a trigger can
 * read the classifier — so a rule can fire on what a lead actually said rather
 * than only on the calendar.
 */

import type { LeadState, PitchResponse, RecommendedAction } from "@/lib/insights/lead-state";
import type { AllStages, LoanType } from "@/types/db";

export const TRIGGER_TYPES = [
  "days_in_stage",
  "no_inbound_since",
  "no_outbound_since",
  "inbound_received",
  "classification_match",
  "stage_changed",
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const ACTION_TYPES = [
  "add_to_bonzo_campaign",
  "move_stage",
  "notify_telegram",
  "create_task",
  "queue_follow_up",
  "mark_adverse",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const RUN_STATUSES = [
  "pending_approval",
  "executed",
  "skipped",
  "failed",
  "dry_run",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Shapes of `trigger_config`, discriminated by the workflow's trigger_type. */
export interface TriggerConfig {
  /** days_in_stage, no_inbound_since, no_outbound_since. */
  days?: number;
  /** days_in_stage, stage_changed. */
  stage?: AllStages;
  /** stage_changed: whether entering or leaving `stage` fires it. */
  direction?: "into" | "out_of";
  /** classification_match: which lead_state field to compare. */
  field?: "pitch_response" | "recommended_action" | "evidence_confidence";
  /** classification_match: the value it must equal. */
  value?: PitchResponse | RecommendedAction | "high" | "medium" | "low";
}

/** Optional filters applied after the trigger matches. */
export interface WorkflowConditions {
  loan_type?: LoanType[];
  stage?: AllStages[];
  min_loan_amount?: number;
  max_loan_amount?: number;
  /**
   * Phase 8 D4. The classifier's read of what the lead did with the number,
   * as a whitelist: the rule fires only when the current pitch_response is in
   * this set.
   *
   * The handoff defaults to ['no_response'] alone. Any actual reply — even a
   * price objection or a soft no — means a live conversation Eddie should
   * work himself, and the failure modes are asymmetric: dumping an engaged
   * lead into a generic campaign is much worse than leaving a dead one to be
   * handed off by hand.
   */
  pitch_response?: PitchResponse[];
}

export interface Workflow {
  id: string;
  user_id: string;
  name: string;
  enabled: boolean;
  dry_run: boolean;
  trigger_type: TriggerType;
  trigger_config: TriggerConfig;
  conditions: WorkflowConditions;
  action_type: ActionType;
  action_config: Record<string, unknown>;
  requires_approval: boolean;
  /**
   * Skips the approval card for this rule only. See D6 — the park rule earns
   * it because its target campaign cannot message anyone.
   */
  auto_approve: boolean;
  priority: number;
  created_at: string;
  updated_at: string;
}

export interface WorkflowRun {
  id: string;
  workflow_id: string;
  contact_id: string;
  fired_at: string;
  status: RunStatus;
  trigger_snapshot: Record<string, unknown>;
  displaced: Record<string, unknown> | null;
  error: string | null;
  occurrence_key: string;
  telegram_message_id: number | null;
}

/**
 * Everything evaluation needs about one lead, gathered once by the caller.
 *
 * Deliberately plain data with no client attached: the whole evaluator is a
 * pure function of these facts, which is what makes the guardrails testable
 * without a database and without a Bonzo account.
 */
export interface LeadFacts {
  contactId: string;
  stage: AllStages;
  loanType: LoanType;
  /** When the lead entered its current stage; null for rows predating the column. */
  stageChangedAt: string | null;
  /** Previous stage, when this evaluation follows a stage change. */
  previousStage: AllStages | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  /** Whether an inbound arrived since the last evaluation. */
  hasNewInbound: boolean;
  leadState: LeadState | null;
  /** When the current lead_state was written; identifies a classification occurrence. */
  leadStateAt: string | null;
  /** Bonzo opt-out or DNC. Any of these bars every message-causing action. */
  optedOut: boolean;
  loanAmount: number | null;
}

/** Three-state view of a workflow, for the builder and for logging. */
export type WorkflowMode = "off" | "dry_run" | "live";

/**
 * Reads the two booleans as one state.
 *
 * `enabled` and `dry_run` are stored separately because the spec names
 * `enabled` and because the kill switch flips one thing. Every read should go
 * through here rather than testing the pair by hand — the ambiguous-looking
 * combination (disabled but not dry-run) is simply off.
 */
export function workflowMode(w: Pick<Workflow, "enabled" | "dry_run">): WorkflowMode {
  if (!w.enabled) return "off";
  return w.dry_run ? "dry_run" : "live";
}

/**
 * Whether a firing of this rule has to wait for a tap.
 *
 * The two flags say different things and are both worth keeping.
 * `requires_approval` is a property of the action — a campaign move is
 * consequential and awkward to reverse. `auto_approve` is a statement about
 * one rule Eddie has watched long enough to trust. Collapsing them would lose
 * the first the moment he grants the second.
 */
export function needsApproval(
  w: Pick<Workflow, "requires_approval" | "auto_approve">
): boolean {
  return w.requires_approval && !w.auto_approve;
}
