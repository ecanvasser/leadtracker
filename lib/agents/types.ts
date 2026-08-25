/**
 * Contact agents — a per-lead follow-up plan Eddie deploys by hand.
 *
 * Read the migration header before changing anything here. The short version:
 * this drafts outside the quoted window, which Phase 8 forbade, and the thing
 * that makes it safe is that `context` is a required human input. An agent is
 * never deployed ambiently. Remove that requirement and the feature becomes
 * the one Phase 7 deleted.
 */

export const AGENT_STATUSES = [
  "draft",
  "active",
  "paused",
  "completed",
  "retired",
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const TOUCH_STATUSES = [
  "pending",
  "drafted",
  "sent",
  "skipped",
  "cancelled",
] as const;
export type TouchStatus = (typeof TOUCH_STATUSES)[number];

/**
 * What each step believes is holding the lead back.
 *
 * Eddie's three, plus timing and an honest unknown. This is the conversion
 * model made explicit: a plan whose steps all say "follow up" is five nudges,
 * while a plan that moves between hypotheses actually tests something. The
 * plan prompt is told to vary these rather than repeat one.
 */
export const HYPOTHESES = [
  "risk",
  "money",
  "competing_promise",
  "timing",
  "unknown",
] as const;
export type Hypothesis = (typeof HYPOTHESES)[number];

export const HYPOTHESIS_LABELS: Record<Hypothesis, string> = {
  risk: "Cold feet",
  money: "Money",
  competing_promise: "Another lender",
  timing: "Timing",
  unknown: "Unclear",
};

export interface AgentStep {
  /** 1-based, in order. */
  step: number;
  /** Days after activation this touch is due. */
  day: number;
  hypothesis: Hypothesis;
  /** One line naming what to lead with. Not a message. */
  angle: string;
  /** Why this step, in Eddie's terms. Shown in the plan preview. */
  rationale: string;
}

export interface AgentPlan {
  /** One line describing the strategy, for the preview header. */
  summary: string;
  steps: AgentStep[];
}

export interface ContactAgent {
  id: string;
  user_id: string;
  contact_id: string;
  status: AgentStatus;
  context: string;
  goal: string;
  plan: AgentPlan;
  duration_days: number;
  paused_reason: string | null;
  created_at: string;
  activated_at: string | null;
  ended_at: string | null;
  updated_at: string;
}

export interface AgentTouch {
  id: string;
  agent_id: string;
  user_id: string;
  contact_id: string;
  step_index: number;
  due_at: string;
  status: TouchStatus;
  queue_item_id: string | null;
  note: string | null;
  drafted_at: string | null;
  settled_at: string | null;
  created_at: string;
}

/** Statuses that occupy the one-live-agent-per-contact slot. */
export const LIVE_AGENT_STATUSES: readonly AgentStatus[] = [
  "draft",
  "active",
  "paused",
];

export function isLiveAgent(status: AgentStatus): boolean {
  return LIVE_AGENT_STATUSES.includes(status);
}

/** The queue row's priority_reason for an agent touch. */
export const AGENT_TOUCH_REASON = "Agent follow-up";

/** Logged to outreach_log for every agent draft, so caps can count them. */
export const AGENT_DRAFT_ACTION = "agent_draft_generated";
