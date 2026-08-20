export const LOAN_TYPES = [
  "cashout",
  "rate_term",
  "heloc",
  "heloan",
  "hei",
  "purchase",
  "hard_money",
  "fast_50",
] as const;
export type LoanType = (typeof LOAN_TYPES)[number];

export const CRM_OPTIONS = ["bonzo", "ghl"] as const;
export type CRM = (typeof CRM_OPTIONS)[number];

export const PIPELINE_STAGES = [
  "hot_lead",
  "app_in",
  "submission",
  "processing",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const ALL_STAGES = [...PIPELINE_STAGES, "adverse"] as const;
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
  app_in: "App In",
  submission: "Submission",
  processing: "Processing",
  adverse: "Adverse",
};

export const LOAN_TYPE_LABELS: Record<LoanType, string> = {
  cashout: "Cash Out",
  rate_term: "Rate & Term",
  heloc: "HELOC",
  heloan: "HE Loan",
  hei: "HEI",
  purchase: "Purchase",
  hard_money: "Hard Money",
  fast_50: "Fast 50",
};

export const CRM_LABELS: Record<CRM, string> = {
  bonzo: "Bonzo",
  ghl: "GHL",
};

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
