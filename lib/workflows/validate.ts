/**
 * Validation for workflows written from the builder.
 *
 * Server-side and strict, for the same reason the settings route is: a
 * malformed workflow does not fail loudly, it sits there looking configured
 * and either never fires or fires on the wrong leads. Both are worse than a
 * rejected save.
 */

import {
  ACTION_TYPES,
  TRIGGER_TYPES,
  type ActionType,
  type TriggerType,
} from "@/lib/workflows/types";
import { ALL_STAGES, LOAN_TYPES, ADVERSE_REASONS } from "@/types/db";
import { PITCH_RESPONSES, RECOMMENDED_ACTIONS } from "@/lib/insights/lead-state";

/** Triggers that need `days` in their config. */
const DAY_TRIGGERS: readonly TriggerType[] = [
  "days_in_stage",
  "no_inbound_since",
  "no_outbound_since",
];

const CLASSIFICATION_FIELDS = [
  "pitch_response",
  "recommended_action",
  "evidence_confidence",
] as const;

const CONFIDENCES = ["high", "medium", "low"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Returns an error message, or null when the payload is acceptable. */
export function validateWorkflow(body: unknown): string | null {
  if (!isRecord(body)) return "Body must be an object";

  const name = body.name;
  if (typeof name !== "string" || !name.trim()) return "Name is required";
  if (name.length > 120) return "Name must be 120 characters or fewer";

  const triggerType = body.trigger_type;
  if (!TRIGGER_TYPES.includes(triggerType as TriggerType)) {
    return `trigger_type must be one of: ${TRIGGER_TYPES.join(", ")}`;
  }
  const actionType = body.action_type;
  if (!ACTION_TYPES.includes(actionType as ActionType)) {
    return `action_type must be one of: ${ACTION_TYPES.join(", ")}`;
  }

  const cfg = body.trigger_config;
  if (cfg !== undefined && !isRecord(cfg)) return "trigger_config must be an object";
  const trigger = (cfg ?? {}) as Record<string, unknown>;

  if (DAY_TRIGGERS.includes(triggerType as TriggerType)) {
    const days = trigger.days;
    if (typeof days !== "number" || !Number.isInteger(days)) {
      return "This trigger needs a whole number of days";
    }
    // Zero would fire on every evaluation forever; the upper bound is a
    // typo guard, not a real limit.
    if (days < 1 || days > 365) return "Days must be between 1 and 365";
  }

  if (triggerType === "days_in_stage" || triggerType === "stage_changed") {
    const stage = trigger.stage;
    if (triggerType === "stage_changed" && stage === undefined) {
      return "stage_changed needs a stage";
    }
    if (stage !== undefined && !ALL_STAGES.includes(stage as never)) {
      return "trigger_config.stage is not a real stage";
    }
    const dir = trigger.direction;
    if (dir !== undefined && dir !== "into" && dir !== "out_of") {
      return "trigger_config.direction must be 'into' or 'out_of'";
    }
  }

  if (triggerType === "classification_match") {
    const field = trigger.field;
    if (!CLASSIFICATION_FIELDS.includes(field as never)) {
      return `classification_match field must be one of: ${CLASSIFICATION_FIELDS.join(", ")}`;
    }
    const value = trigger.value;
    const allowed =
      field === "pitch_response"
        ? (PITCH_RESPONSES as readonly string[])
        : field === "recommended_action"
          ? (RECOMMENDED_ACTIONS as readonly string[])
          : (CONFIDENCES as readonly string[]);
    if (typeof value !== "string" || !allowed.includes(value)) {
      return `For ${String(field)}, value must be one of: ${allowed.join(", ")}`;
    }
  }

  const actionCfg = body.action_config;
  if (actionCfg !== undefined && !isRecord(actionCfg)) {
    return "action_config must be an object";
  }
  const action = (actionCfg ?? {}) as Record<string, unknown>;

  if (actionType === "add_to_bonzo_campaign") {
    const id = action.campaign_id;
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
      return "Pick a Bonzo campaign";
    }
  }
  if (actionType === "move_stage") {
    if (!ALL_STAGES.includes(action.stage as never)) {
      return "move_stage needs a target stage";
    }
  }
  if (actionType === "mark_adverse") {
    if (!ADVERSE_REASONS.includes(action.reason as never)) {
      return "mark_adverse needs a reason";
    }
  }
  if (actionType === "notify_telegram" || actionType === "create_task") {
    const text = action.message ?? action.title;
    if (typeof text !== "string" || !text.trim()) {
      return "This action needs some text";
    }
    if (text.length > 500) return "Text must be 500 characters or fewer";
  }

  const conditions = body.conditions;
  if (conditions !== undefined) {
    if (!isRecord(conditions)) return "conditions must be an object";
    const lt = conditions.loan_type;
    if (lt !== undefined) {
      if (!Array.isArray(lt) || lt.some((v) => !LOAN_TYPES.includes(v as never))) {
        return "conditions.loan_type contains an unknown loan type";
      }
    }
    const st = conditions.stage;
    if (st !== undefined) {
      if (!Array.isArray(st) || st.some((v) => !ALL_STAGES.includes(v as never))) {
        return "conditions.stage contains an unknown stage";
      }
    }
    for (const key of ["min_loan_amount", "max_loan_amount"] as const) {
      const v = conditions[key];
      if (v !== undefined && v !== null && (typeof v !== "number" || v < 0)) {
        return `conditions.${key} must be a positive number`;
      }
    }
    const min = conditions.min_loan_amount;
    const max = conditions.max_loan_amount;
    if (typeof min === "number" && typeof max === "number" && min > max) {
      return "Minimum loan amount cannot exceed the maximum";
    }
  }

  const priority = body.priority;
  if (priority !== undefined) {
    if (typeof priority !== "number" || !Number.isInteger(priority)) {
      return "priority must be a whole number";
    }
    if (priority < 0 || priority > 10_000) return "priority must be between 0 and 10000";
  }

  for (const flag of ["enabled", "dry_run", "requires_approval"] as const) {
    if (body[flag] !== undefined && typeof body[flag] !== "boolean") {
      return `${flag} must be true or false`;
    }
  }

  /*
   * The one cross-field rule worth enforcing server-side rather than trusting
   * the UI: a live campaign handoff with no approval is the single most
   * consequential configuration in the app — it messages clients under Eddie's
   * name with nothing in the loop. It is reachable, but only by clearing
   * dry_run and requires_approval deliberately, never as a default.
   */
  if (
    body.enabled === true &&
    body.dry_run === false &&
    body.requires_approval === false &&
    actionType === "add_to_bonzo_campaign" &&
    body.acknowledge_unattended !== true
  ) {
    return "A live campaign handoff with no approval step needs to be confirmed explicitly";
  }

  return null;
}
