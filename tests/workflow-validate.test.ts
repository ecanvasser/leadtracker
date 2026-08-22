import { describe, it, expect } from "vitest";
import { validateWorkflow } from "@/lib/workflows/validate";

/** A valid payload; each test breaks exactly one thing. */
function body(over: Record<string, unknown> = {}) {
  return {
    name: "2-day handoff",
    trigger_type: "no_inbound_since",
    trigger_config: { days: 2 },
    conditions: { stage: ["quoted_follow_up"] },
    action_type: "add_to_bonzo_campaign",
    action_config: { campaign_id: 43998 },
    requires_approval: true,
    priority: 100,
    ...over,
  };
}

describe("validateWorkflow", () => {
  it("accepts the seed workflow shape", () => {
    expect(validateWorkflow(body())).toBeNull();
  });

  it("requires a name", () => {
    expect(validateWorkflow(body({ name: "  " }))).toContain("Name");
  });

  it("rejects unknown trigger and action types", () => {
    expect(validateWorkflow(body({ trigger_type: "vibes" }))).toContain("trigger_type");
    expect(validateWorkflow(body({ action_type: "delete_everything" }))).toContain("action_type");
  });

  describe("day triggers", () => {
    it("needs a whole number of days", () => {
      expect(validateWorkflow(body({ trigger_config: {} }))).toContain("days");
      expect(validateWorkflow(body({ trigger_config: { days: 2.5 } }))).toContain("days");
      expect(validateWorkflow(body({ trigger_config: { days: "2" } }))).toContain("days");
    });

    it("rejects zero days", () => {
      // Zero would match on every evaluation forever — the rule would fire on
      // a lead the instant they were quoted.
      expect(validateWorkflow(body({ trigger_config: { days: 0 } }))).toContain("between 1 and 365");
    });

    it("rejects a negative or absurd number", () => {
      expect(validateWorkflow(body({ trigger_config: { days: -1 } }))).toBeTruthy();
      expect(validateWorkflow(body({ trigger_config: { days: 5000 } }))).toBeTruthy();
    });
  });

  describe("classification triggers", () => {
    const cls = (cfg: Record<string, unknown>) =>
      validateWorkflow(body({ trigger_type: "classification_match", trigger_config: cfg }));

    it("accepts a real field and a value from that field's own enum", () => {
      expect(cls({ field: "pitch_response", value: "competitor" })).toBeNull();
      expect(cls({ field: "recommended_action", value: "hand_off" })).toBeNull();
      expect(cls({ field: "evidence_confidence", value: "high" })).toBeNull();
    });

    it("rejects a value from the wrong enum", () => {
      // "hand_off" is a recommended_action, not a pitch_response. Allowing the
      // cross would create a rule that can never match, silently.
      expect(cls({ field: "pitch_response", value: "hand_off" })).toContain("must be one of");
    });

    it("rejects an unknown field", () => {
      expect(cls({ field: "lead_temp", value: "warm" })).toContain("field must be one of");
    });
  });

  describe("stage triggers", () => {
    it("requires a stage for stage_changed", () => {
      expect(
        validateWorkflow(body({ trigger_type: "stage_changed", trigger_config: {} }))
      ).toContain("needs a stage");
    });

    it("rejects a stage that does not exist", () => {
      expect(
        validateWorkflow(
          body({ trigger_type: "stage_changed", trigger_config: { stage: "nurturing" } })
        )
      ).toContain("not a real stage");
    });

    it("rejects a bad direction", () => {
      expect(
        validateWorkflow(
          body({
            trigger_type: "stage_changed",
            trigger_config: { stage: "quoted_follow_up", direction: "sideways" },
          })
        )
      ).toContain("direction");
    });
  });

  describe("action config", () => {
    it("requires a campaign for a campaign handoff", () => {
      expect(validateWorkflow(body({ action_config: {} }))).toContain("campaign");
      expect(validateWorkflow(body({ action_config: { campaign_id: "43998" } }))).toContain("campaign");
    });

    it("requires a real stage for move_stage", () => {
      expect(
        validateWorkflow(body({ action_type: "move_stage", action_config: { stage: "nope" } }))
      ).toContain("target stage");
    });

    it("requires a known reason for mark_adverse", () => {
      expect(
        validateWorkflow(body({ action_type: "mark_adverse", action_config: { reason: "vibes" } }))
      ).toContain("reason");
    });

    it("requires text for a notification or task", () => {
      expect(
        validateWorkflow(body({ action_type: "notify_telegram", action_config: {} }))
      ).toContain("text");
      expect(
        validateWorkflow(body({ action_type: "create_task", action_config: { title: "  " } }))
      ).toContain("text");
    });
  });

  describe("conditions", () => {
    it("rejects unknown loan types and stages", () => {
      expect(validateWorkflow(body({ conditions: { loan_type: ["crypto"] } }))).toContain("loan type");
      expect(validateWorkflow(body({ conditions: { stage: ["nurturing"] } }))).toContain("stage");
    });

    it("rejects an inverted amount range", () => {
      expect(
        validateWorkflow(body({ conditions: { min_loan_amount: 500_000, max_loan_amount: 100_000 } }))
      ).toContain("cannot exceed");
    });

    it("accepts a sane range", () => {
      expect(
        validateWorkflow(body({ conditions: { min_loan_amount: 100_000, max_loan_amount: 500_000 } }))
      ).toBeNull();
    });
  });

  /*
   * The one cross-field rule. A live campaign handoff with no approval step
   * messages clients under Eddie's name with nothing in the loop — reachable,
   * but only deliberately.
   */
  describe("unattended live handoff", () => {
    const unattended = {
      enabled: true,
      dry_run: false,
      requires_approval: false,
    };

    it("refuses without an explicit acknowledgement", () => {
      expect(validateWorkflow(body(unattended))).toContain("confirmed explicitly");
    });

    it("allows it when acknowledged", () => {
      expect(validateWorkflow(body({ ...unattended, acknowledge_unattended: true }))).toBeNull();
    });

    it("does not block the same settings on a harmless action", () => {
      // notify_telegram unattended is fine — it messages Eddie, not a client.
      expect(
        validateWorkflow(
          body({
            ...unattended,
            action_type: "notify_telegram",
            action_config: { message: "gone quiet" },
          })
        )
      ).toBeNull();
    });

    it("does not block a live handoff that still asks first", () => {
      expect(
        validateWorkflow(body({ enabled: true, dry_run: false, requires_approval: true }))
      ).toBeNull();
    });

    it("does not block a dry-run handoff with approval waived", () => {
      // Dry-run cannot act, so there is nothing to confirm.
      expect(
        validateWorkflow(body({ enabled: true, dry_run: true, requires_approval: false }))
      ).toBeNull();
    });
  });

  it("rejects a non-object body", () => {
    expect(validateWorkflow(null)).toBeTruthy();
    expect(validateWorkflow("workflow")).toBeTruthy();
    expect(validateWorkflow([])).toBeTruthy();
  });
});
