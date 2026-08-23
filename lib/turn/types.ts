/**
 * The whose-turn model — Phase 8 section 1.
 *
 * Stage tracks how far a deal has progressed. Whose-turn tracks whether Eddie
 * should act. They are different questions and the board only ever answered
 * the first one.
 *
 * Everything here is **derived, never stored**. There is no `turn` column and
 * there must not be one: a stored verdict goes stale the moment a lead
 * replies, and a Today screen that is confidently wrong is worse than no
 * Today screen. The cost of recomputing is a few microseconds per lead
 * against data the app has already loaded.
 */

import type { LeadState } from "@/lib/insights/lead-state";
import type { AllStages, LoanType } from "@/types/db";

export type Turn = "yours" | "theirs" | "waiting";

/**
 * Where a lead renders on the Today screen.
 *
 * Deliberately not the same thing as {@link Turn}. Section 2.4: a `theirs`
 * lead only earns the second section once it is *overdue* — before that it
 * belongs in Waiting, visible but not shouting. So `theirs` splits across two
 * sections and the mapping lives in one place rather than in each caller.
 */
export type TodaySection = "your_move" | "their_move" | "waiting";

export interface TurnSettings {
  /**
   * Days of silence before a `theirs` lead becomes overdue and surfaces in
   * the second section. Section 2.4 — lives in user_settings so it is
   * tunable without a deploy.
   */
  overdueDays: number;
  /**
   * Hours after Eddie's own last outbound within which a lead is described as
   * just-touched rather than merely waiting. Cosmetic: it only changes the
   * reason string, never the section.
   */
  recentTouchHours: number;
}

export const DEFAULT_TURN_SETTINGS: TurnSettings = {
  overdueDays: 2,
  recentTouchHours: 4,
};

/** The contact columns the verdict actually depends on. */
export interface TurnContact {
  id: string;
  name: string;
  loan_type: LoanType;
  stage: AllStages;
  /**
   * Maintained by a database trigger. The correct "when did this happen"
   * field — `updated_at` moves on any edit at all and must not stand in.
   */
  stage_changed_at: string | null;
  bonzo_prospect_id: number | null;
  insights_enabled: boolean;
}

/**
 * The insights_cache row, or null when the lead has never been synced.
 *
 * `last_inbound_at` / `last_outbound_at` are watermark columns rather than
 * anything read out of `lead_state`, because D1 widened the refresh sweep to
 * every stage while classification stayed gated on Quoted – Follow Up. A
 * Needs Quote lead therefore has watermarks but no `lead_state` at all, and
 * the direction of the last message — the most valuable signal in the
 * product — has to survive that.
 */
export interface TurnCache {
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_message_at: string | null;
  lead_state: LeadState | null;
}

export interface TurnTask {
  id: string;
  title: string;
  due_date: string | null;
  is_done: boolean;
}

export interface TurnCall {
  scheduled_at: string;
  status: string;
}

/** A recorded handoff into a Bonzo nurture campaign. */
export interface TurnHandoff {
  campaign_name: string | null;
  at: string;
}

export interface TurnInput {
  contact: TurnContact;
  cache: TurnCache | null;
  tasks: TurnTask[];
  calls: TurnCall[];
  handoff: TurnHandoff | null;
  now: Date;
  timeZone: string;
  settings: TurnSettings;
}

export interface TurnVerdict {
  turn: Turn;
  section: TodaySection;
  /**
   * How long this lead has been in its current turn state (section 1.2).
   * Null only when nothing anchors it — a lead with no history and no stage
   * clock. Sorting treats null as newest so unknowns never squat at the top.
   */
  waiting_since: string | null;
  /**
   * Short, human-readable, and **required** for anything in the Waiting
   * section (1.3). A Waiting list without reasons is just a list of leads
   * being ignored; with reasons it is a list that can be scanned in twenty
   * seconds and trusted. Null is only ever valid for the two actionable
   * sections.
   */
  reason: string | null;
  overdue: boolean;
}

export interface TurnResult extends TurnVerdict {
  contact: TurnContact;
  /** Carried through for rendering: the badge and angle on a `theirs` row. */
  leadState: LeadState | null;
}
