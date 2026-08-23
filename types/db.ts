export const LOAN_TYPES = [
  "cashout",
  "rate_term",
  "heloc",
  "heloan",
  "hei",
  "purchase",
  "hard_money",
  "fast_50",
  "reverse",
] as const;
export type LoanType = (typeof LOAN_TYPES)[number];

export const CRM_OPTIONS = ["bonzo", "ghl"] as const;
export type CRM = (typeof CRM_OPTIONS)[number];

export const PIPELINE_STAGES = [
  "hot_lead",
  "needs_quote",
  "quoted_follow_up",
  "app_in",
  "submission",
  "processing",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/**
 * Every stage a contact can hold, including the two that are not board
 * columns. 'adverse' and 'funded' are both terminal and both live on their own
 * page — a dead deal and a closed one are the two things that should leave the
 * board rather than sit in a column forever.
 */
export const ALL_STAGES = [...PIPELINE_STAGES, "adverse", "funded"] as const;

/** Terminal stages: off the board, listed on their own pages. */
export const TERMINAL_STAGES = ["adverse", "funded"] as const;
export type TerminalStage = (typeof TERMINAL_STAGES)[number];
export type AllStages = (typeof ALL_STAGES)[number];

export const ADVERSE_REASONS = [
  "credit",
  "equity",
  "income",
  "not_interested",
  "other_lender",
  "title_issue",
] as const;
export type AdverseReason = (typeof ADVERSE_REASONS)[number];

export const STAGE_LABELS: Record<AllStages, string> = {
  hot_lead: "Hot Leads",
  needs_quote: "Needs Quote",
  quoted_follow_up: "Quoted – Follow Up",
  app_in: "App In",
  submission: "Submission",
  processing: "Processing",
  adverse: "Adverse",
  funded: "Funded",
};

export const LOAN_TYPE_LABELS: Record<LoanType, string> = {
  cashout: "Cash Out",
  rate_term: "Rate & Term",
  heloc: "HELOC",
  heloan: "HELOAN",
  hei: "HEI",
  purchase: "Purchase",
  hard_money: "Hard Money",
  fast_50: "Fast 50",
  reverse: "Reverse",
};

export const CRM_LABELS: Record<CRM, string> = {
  bonzo: "Bonzo",
  ghl: "GHL",
};

/**
 * The stage a lead lands in when none was chosen. The literal lives here and
 * nowhere else, so the one place that decides the default is greppable.
 */
export const DEFAULT_STAGE = "hot_lead" as const satisfies AllStages;

/**
 * Stages that receive automation: classification, the daily queue, workflow
 * evaluation and Telegram pushes. Every automation path must reference this —
 * never a bare stage comparison. Adding a stage without adding it here
 * silently removes those leads from all automation.
 *
 * Phase 7: this moved from ['hot_lead'] to ['quoted_follow_up'], and that one
 * edit is the whole point of the phase. Hot Lead and Needs Quote are hands-on
 * — Eddie asks the qualifying questions and builds the quotes himself, and
 * knows what those leads need. The problem worth automating starts after the
 * pitch, when a lead has heard the number and either moves or goes quiet.
 *
 * Consequence to keep in mind: dragging a card out of Quoted – Follow Up stops
 * its automation. That is deliberate — it is also how a conversion is detected
 * (D4), since moving a lead to App In is what tells the app to stop chasing.
 */
export const QUEUE_ELIGIBLE_STAGES = ["quoted_follow_up"] as const;
export type QueueEligibleStage = (typeof QUEUE_ELIGIBLE_STAGES)[number];

/** Membership test for {@link QUEUE_ELIGIBLE_STAGES}. */
export function isQueueEligible(stage: string | null | undefined): boolean {
  return QUEUE_ELIGIBLE_STAGES.includes(stage as QueueEligibleStage);
}

export const ADVERSE_REASON_LABELS: Record<AdverseReason, string> = {
  credit: "Credit",
  equity: "Equity",
  income: "Income",
  not_interested: "Not Interested",
  other_lender: "Other Lender",
  title_issue: "Title Issue",
};

export interface Contact {
  id: string;
  user_id: string;
  name: string;
  loan_type: LoanType;
  crm: CRM;
  stage: AllStages;
  position: number;
  adverse_reason: AdverseReason | null;
  notes: string | null;
  bonzo_prospect_id: number | null;
  bonzo_email: string | null;
  insights_enabled: boolean;
  /** Captured from Bonzo at enrollment; call reminders read it. See 3.4. */
  phone: string | null;
  /**
   * When the contact entered its current stage, maintained by a database
   * trigger. Phase 7 needs it for days_since_pitch and the days_in_stage
   * workflow trigger, and it is a better "when did this happen" than
   * updated_at, which moves on any edit at all.
   */
  stage_changed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  user_id: string;
  contact_id: string;
  title: string;
  is_done: boolean;
  due_date: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface TaskWithContact extends Task {
  contacts: Pick<Contact, "name" | "loan_type">;
}

export interface TelegramLink {
  id: string;
  user_id: string;
  telegram_user_id: number;
  created_at: string;
}

export interface TelegramLinkToken {
  token: string;
  user_id: string;
  expires_at: string;
  used: boolean;
  created_at: string;
}
