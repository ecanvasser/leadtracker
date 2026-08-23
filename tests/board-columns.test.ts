import { describe, it, expect } from "vitest";
import {
  BOARD_COLUMNS,
  columnById,
  columnForStage,
  stageForDrop,
} from "@/components/board/columns";
import { PIPELINE_STAGES, TERMINAL_STAGES, type AllStages } from "@/types/db";

/**
 * Phase 8 D2 — six columns rendered as four, with no migration.
 *
 * The whole bet is that the merge is a rendering decision: every stage stays
 * in the enum, on the contacts it is on. These tests are what stops it
 * quietly becoming a data change.
 */
describe("board columns", () => {
  it("renders four columns", () => {
    expect(BOARD_COLUMNS).toHaveLength(4);
    expect(BOARD_COLUMNS.map((c) => c.label)).toEqual([
      "Hot Leads",
      "Needs Quote",
      "Quoted – Follow Up",
      "In Process",
    ]);
  });

  it("gives every pipeline stage exactly one column", () => {
    for (const stage of PIPELINE_STAGES) {
      const matches = BOARD_COLUMNS.filter((c) =>
        (c.stages as readonly string[]).includes(stage)
      );
      expect(matches, stage).toHaveLength(1);
    }
  });

  it("keeps all six stages on the board — the merge hides nothing", () => {
    const rendered = BOARD_COLUMNS.flatMap((c) => [...c.stages]);
    expect([...rendered].sort()).toEqual([...PIPELINE_STAGES].sort());
  });

  it("leaves the terminal stages off the board entirely", () => {
    for (const stage of TERMINAL_STAGES) {
      expect(columnForStage(stage), stage).toBeUndefined();
    }
  });

  it("merges App In, Submission and Processing into one column", () => {
    const inProcess = columnForStage("app_in");
    expect(inProcess?.id).toBe("col_in_process");
    expect(columnForStage("submission")?.id).toBe("col_in_process");
    expect(columnForStage("processing")?.id).toBe("col_in_process");
    expect(inProcess?.stages).toEqual(["app_in", "submission", "processing"]);
  });

  it("uses column ids that cannot be mistaken for stage names", () => {
    const stageNames = new Set<string>([...PIPELINE_STAGES, ...TERMINAL_STAGES]);
    for (const column of BOARD_COLUMNS) {
      expect(stageNames.has(column.id), column.id).toBe(false);
      expect(columnById(column.id)).toBe(column);
    }
  });
});

describe("stageForDrop", () => {
  const inProcess = columnForStage("app_in")!;

  it("assigns App In when a card arrives from another column", () => {
    expect(stageForDrop(inProcess, "quoted_follow_up")).toBe("app_in");
    expect(stageForDrop(inProcess, "hot_lead")).toBe("app_in");
  });

  /*
   * The reason this function exists. Without it, nudging a Processing card up
   * two places inside its own column would rewrite its stage to App In — a
   * reorder silently demoting a deal that is with the lender, and writing a
   * false row to stage_transitions while it was at it.
   */
  it("leaves a card's stage alone when it is reordered inside its own column", () => {
    expect(stageForDrop(inProcess, "submission")).toBe("submission");
    expect(stageForDrop(inProcess, "processing")).toBe("processing");
    expect(stageForDrop(inProcess, "app_in")).toBe("app_in");
  });

  it("is the identity for every single-stage column", () => {
    for (const column of BOARD_COLUMNS.filter((c) => c.stages.length === 1)) {
      const only = column.stages[0];
      expect(stageForDrop(column, only)).toBe(only);
      // And still assigns its one stage to anything arriving from elsewhere.
      expect(stageForDrop(column, "processing")).toBe(only);
    }
  });

  it("never returns a terminal stage", () => {
    const everyStage: AllStages[] = [...PIPELINE_STAGES, ...TERMINAL_STAGES];
    for (const column of BOARD_COLUMNS) {
      for (const from of everyStage) {
        expect(TERMINAL_STAGES as readonly string[]).not.toContain(
          stageForDrop(column, from)
        );
      }
    }
  });
});
