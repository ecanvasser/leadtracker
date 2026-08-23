import type { AllStages, PipelineStage } from "@/types/db";

/**
 * The board's columns, which are no longer one-to-one with pipeline stages.
 *
 * Phase 8 D2: six columns become four by merging App In, Submission and
 * Processing into one "In Process" column. **Deliberately done without a
 * migration.** All three stages stay in the `pipeline_stage` enum, on the
 * contacts they are on, readable by every workflow and query that already
 * reads them — the merge is a rendering decision and nothing else. That makes
 * it fully reversible: deleting this file and mapping columns back to stages
 * restores the old board exactly, with no data to migrate back.
 *
 * The specific stage is not lost from view either; a card in a merged column
 * wears it as a badge, and the badge is how it gets changed.
 *
 * Four columns also removes the reason the collapse mechanic existed. Six
 * pipeline stages plus Todo needed 1964px and a 1440px laptop has 1440, so
 * three columns started folded — which meant the board looked different on
 * first load with no explanation on screen. Four fit natively.
 */
export interface BoardColumn {
  /** Droppable id. Distinct from any stage name so the two cannot be confused. */
  id: string;
  label: string;
  /** Every stage this column renders, in pipeline order. */
  stages: readonly PipelineStage[];
  /**
   * The stage a card takes when dropped in from another column. For the
   * merged column this is App In — the first of the three and the only one a
   * lead can reasonably arrive at from Quoted – Follow Up. Landing on the
   * wrong one is a badge click away.
   */
  dropStage: PipelineStage;
}

export const BOARD_COLUMNS: readonly BoardColumn[] = [
  { id: "col_hot_lead", label: "Hot Leads", stages: ["hot_lead"], dropStage: "hot_lead" },
  { id: "col_needs_quote", label: "Needs Quote", stages: ["needs_quote"], dropStage: "needs_quote" },
  {
    id: "col_quoted_follow_up",
    label: "Quoted – Follow Up",
    stages: ["quoted_follow_up"],
    dropStage: "quoted_follow_up",
  },
  {
    id: "col_in_process",
    label: "In Process",
    stages: ["app_in", "submission", "processing"],
    dropStage: "app_in",
  },
] as const;

/** The column a stage renders in, or undefined for a terminal stage. */
export function columnForStage(stage: AllStages): BoardColumn | undefined {
  return BOARD_COLUMNS.find((c) => (c.stages as readonly string[]).includes(stage));
}

export function columnById(id: string): BoardColumn | undefined {
  return BOARD_COLUMNS.find((c) => c.id === id);
}

/**
 * The stage a card should end up in when dropped on a column.
 *
 * A drag that stays inside the merged column must not rewrite the stage — a
 * Processing card nudged up two places is a reorder, not a demotion back to
 * App In. So the current stage wins whenever the column already contains it.
 */
export function stageForDrop(column: BoardColumn, currentStage: AllStages): PipelineStage {
  return (column.stages as readonly string[]).includes(currentStage)
    ? (currentStage as PipelineStage)
    : column.dropStage;
}
