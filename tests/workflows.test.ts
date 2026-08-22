import { describe, it, expect } from "vitest";
import {
  evaluateWorkflows,
  hardStopReason,
  verifyStillValid,
  conditionsPass,
  causesMessage,
} from "@/lib/workflows/evaluate";
import { matchTrigger, daysSince } from "@/lib/workflows/triggers";
import { workflowMode, type LeadFacts, type Workflow } from "@/lib/workflows/types";
import type { LeadState } from "@/lib/insights/lead-state";

const NOW = new Date("2026-08-22T18:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

function workflow(over: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf-1",
    user_id: "user-1",
    name: "2-day handoff",
    enabled: true,
    dry_run: true,
    trigger_type: "no_inbound_since",
    trigger_config: { days: 2 },
    conditions: {},
    action_type: "add_to_bonzo_campaign",
    action_config: { campaign_id: 43998 },
    requires_approval: true,
    priority: 100,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    ...over,
  };
}

function leadState(over: Partial<LeadState> = {}): LeadState {
  return {
    pitch_response: "no_response",
    evidence: null,
    evidence_confidence: "low",
    suggested_angle: "No reply since the quote — try a different channel.",
    last_inbound_at: null,
    last_outbound_at: null,
    days_since_pitch: 3,
    recommended_action: "follow_up",
    suppress_until: null,
    ...over,
  };
}

function facts(over: Partial<LeadFacts> = {}): LeadFacts {
  return {
    contactId: "contact-1",
    stage: "quoted_follow_up",
    loanType: "cashout",
    stageChangedAt: ago(5),
    previousStage: null,
    lastInboundAt: ago(3),
    lastOutboundAt: ago(1),
    hasNewInbound: false,
    leadState: leadState(),
    leadStateAt: ago(1),
    optedOut: false,
    loanAmount: 250_000,
    ...over,
  };
}

function evaluate(over: {
  workflows?: Workflow[];
  facts?: LeadFacts;
  workflowsEnabled?: boolean;
  firedOccurrences?: Map<string, Set<string>>;
} = {}) {
  return evaluateWorkflows({
    workflows: over.workflows ?? [workflow()],
    facts: over.facts ?? facts(),
    workflowsEnabled: over.workflowsEnabled ?? true,
    firedOccurrences: over.firedOccurrences ?? new Map(),
    now: NOW,
  });
}

describe("workflowMode", () => {
  it("reads the two booleans as three states", () => {
    expect(workflowMode({ enabled: false, dry_run: true })).toBe("off");
    expect(workflowMode({ enabled: true, dry_run: true })).toBe("dry_run");
    expect(workflowMode({ enabled: true, dry_run: false })).toBe("live");
  });

  it("treats disabled-but-not-dry-run as off, not live", () => {
    // The ambiguous-looking pair. Getting this backwards would make a
    // workflow Eddie switched off act for real.
    expect(workflowMode({ enabled: false, dry_run: false })).toBe("off");
  });
});

/*
 * Spec section 7: a lead matching three workflows fires exactly one, the
 * lowest-priority-number match. Without this a quiet lead lands in three
 * campaigns at once.
 */
describe("one action per lead per evaluation", () => {
  const three = [
    workflow({ id: "wf-low", name: "low priority", priority: 300 }),
    workflow({ id: "wf-first", name: "first", priority: 10 }),
    workflow({ id: "wf-mid", name: "middle", priority: 100 }),
  ];

  it("fires exactly one, the lowest priority number", () => {
    const out = evaluate({ workflows: three });
    expect(out.fired).toBe(true);
    if (!out.fired) return;
    expect(out.workflow.id).toBe("wf-first");
    expect(out.considered.filter((c) => c.outcome === "fired")).toHaveLength(1);
  });

  it("records the losers as unreached rather than silently dropping them", () => {
    const out = evaluate({ workflows: three });
    const unreached = out.considered.filter((c) => c.outcome === "not_reached");
    expect(unreached.map((c) => c.workflowId).sort()).toEqual(["wf-low", "wf-mid"]);
  });

  it("breaks priority ties deterministically, not by array order", () => {
    // Dry-run observation is worthless if what fires today is not what fires
    // tomorrow from the same data.
    const tied = [
      workflow({ id: "wf-b", priority: 100, created_at: "2026-08-02T00:00:00Z" }),
      workflow({ id: "wf-a", priority: 100, created_at: "2026-08-01T00:00:00Z" }),
    ];
    const first = evaluate({ workflows: tied });
    const second = evaluate({ workflows: [...tied].reverse() });
    expect(first.fired && first.workflow.id).toBe("wf-a");
    expect(second.fired && second.workflow.id).toBe("wf-a");
  });

  it("skips a workflow that is off and fires the next one", () => {
    const out = evaluate({
      workflows: [
        workflow({ id: "wf-off", priority: 1, enabled: false }),
        workflow({ id: "wf-on", priority: 2 }),
      ],
    });
    expect(out.fired && out.workflow.id).toBe("wf-on");
    expect(out.considered.find((c) => c.workflowId === "wf-off")?.outcome).toBe("off");
  });
});

/* Spec section 7: a workflow does not re-fire for the same trigger occurrence. */
describe("idempotency", () => {
  it("does not re-fire for the same occurrence", () => {
    const wf = workflow();
    const match = matchTrigger(wf, facts(), NOW);
    expect(match.matched).toBe(true);

    const out = evaluate({
      workflows: [wf],
      firedOccurrences: new Map([[wf.id, new Set([match.occurrenceKey])]]),
    });
    expect(out.fired).toBe(false);
    expect(out.considered[0].outcome).toBe("already_fired");
  });

  it("keys a quiet spell on the last inbound, so it is one occurrence not one per day", () => {
    const wf = workflow();
    const today = matchTrigger(wf, facts({ lastInboundAt: ago(3) }), NOW);
    const tomorrow = matchTrigger(
      wf,
      facts({ lastInboundAt: ago(3) }),
      new Date(NOW.getTime() + 86_400_000)
    );
    expect(today.occurrenceKey).toBe(tomorrow.occurrenceKey);
  });

  it("treats a genuinely new reply as a new occurrence", () => {
    const wf = workflow();
    const before = matchTrigger(wf, facts({ lastInboundAt: ago(9) }), NOW);
    const after = matchTrigger(wf, facts({ lastInboundAt: ago(3) }), NOW);
    expect(before.occurrenceKey).not.toBe(after.occurrenceKey);
  });

  it("keys days_in_stage on the stage entry, not the day it crossed", () => {
    const wf = workflow({ trigger_type: "days_in_stage", trigger_config: { days: 2, stage: "quoted_follow_up" } });
    const entered = ago(5);
    const day5 = matchTrigger(wf, facts({ stageChangedAt: entered }), NOW);
    const day6 = matchTrigger(
      wf,
      facts({ stageChangedAt: entered }),
      new Date(NOW.getTime() + 86_400_000)
    );
    expect(day5.matched && day6.matched).toBe(true);
    expect(day5.occurrenceKey).toBe(day6.occurrenceKey);
  });
});

/* Spec section 7: an opted-out or adverse lead triggers no action. */
describe("hard stops", () => {
  it("refuses an opted-out lead even when the trigger matches", () => {
    const out = evaluate({ facts: facts({ optedOut: true }) });
    expect(out.fired).toBe(false);
    expect(out.fired === false && out.reason).toContain("opted out");
  });

  it("refuses an adverse lead", () => {
    expect(evaluate({ facts: facts({ stage: "adverse" }) }).fired).toBe(false);
  });

  it("refuses a funded lead", () => {
    expect(evaluate({ facts: facts({ stage: "funded" }) }).fired).toBe(false);
  });

  it("refuses a lead that has moved off the automated stage", () => {
    // This is also how conversion stops follow-up under D4: Eddie moving the
    // lead to App In is the signal.
    const out = evaluate({ facts: facts({ stage: "app_in" }) });
    expect(out.fired).toBe(false);
    expect(out.fired === false && out.reason).toContain("not automated");
  });

  it("refuses hands-on stages too", () => {
    expect(hardStopReason(facts({ stage: "hot_lead" }))).toContain("not automated");
    expect(hardStopReason(facts({ stage: "needs_quote" }))).toContain("not automated");
  });

  it("lets a normal quoted_follow_up lead through", () => {
    expect(hardStopReason(facts())).toBeNull();
  });
});

/* Spec section 7: a lead whose stage changed between evaluation and execution is skipped. */
describe("execution-time re-check", () => {
  it("skips a lead that converted after evaluation", () => {
    const r = verifyStillValid(facts({ stage: "app_in" }), "quoted_follow_up");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("stage changed");
  });

  it("skips a lead that opted out after evaluation", () => {
    const r = verifyStillValid(facts({ optedOut: true }), "quoted_follow_up");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("opted out");
  });

  it("allows an unchanged lead", () => {
    expect(verifyStillValid(facts(), "quoted_follow_up").ok).toBe(true);
  });
});

describe("kill switch", () => {
  it("halts everything when workflows_enabled is false", () => {
    const out = evaluate({ workflowsEnabled: false });
    expect(out.fired).toBe(false);
    expect(out.fired === false && out.reason).toContain("paused");
  });

  it("stops evaluation before any workflow is considered", () => {
    // Not merely before acting — a paused system should not be producing
    // dry-run rows either.
    expect(evaluate({ workflowsEnabled: false }).considered).toHaveLength(0);
  });
});

/* Spec section 7: dry-run writes rows and makes zero Bonzo calls. */
describe("dry-run is the default and does not act", () => {
  it("plans a dry_run status for a new workflow", () => {
    const out = evaluate();
    expect(out.fired && out.plannedStatus).toBe("dry_run");
  });

  it("plans pending_approval when live and approval is required", () => {
    const out = evaluate({ workflows: [workflow({ dry_run: false, requires_approval: true })] });
    expect(out.fired && out.plannedStatus).toBe("pending_approval");
  });

  it("plans executed only when live and approval is waived", () => {
    const out = evaluate({ workflows: [workflow({ dry_run: false, requires_approval: false })] });
    expect(out.fired && out.plannedStatus).toBe("executed");
  });

  it("a dry-run campaign handoff never plans to execute", () => {
    // The whole point of watching a workflow for a few days before trusting it.
    const out = evaluate({ workflows: [workflow({ action_type: "add_to_bonzo_campaign" })] });
    expect(out.fired && out.plannedStatus).not.toBe("executed");
  });
});

describe("conditions", () => {
  it("filters on loan type", () => {
    const wf = workflow({ conditions: { loan_type: ["heloc"] } });
    expect(conditionsPass(wf, facts({ loanType: "cashout" })).pass).toBe(false);
    expect(conditionsPass(wf, facts({ loanType: "heloc" })).pass).toBe(true);
  });

  it("filters on an amount range", () => {
    const wf = workflow({ conditions: { min_loan_amount: 100_000, max_loan_amount: 300_000 } });
    expect(conditionsPass(wf, facts({ loanAmount: 250_000 })).pass).toBe(true);
    expect(conditionsPass(wf, facts({ loanAmount: 50_000 })).pass).toBe(false);
    expect(conditionsPass(wf, facts({ loanAmount: 400_000 })).pass).toBe(false);
  });

  it("fails an amount filter when the amount is unknown rather than assuming", () => {
    // Bonzo often has no mortgage fields. Treating unknown as passing would
    // fire a big-loan-only rule on every lead with a blank file.
    const wf = workflow({ conditions: { min_loan_amount: 100_000 } });
    expect(conditionsPass(wf, facts({ loanAmount: null })).pass).toBe(false);
  });

  it("applies conditions only after the trigger matched", () => {
    const out = evaluate({
      workflows: [workflow({ conditions: { loan_type: ["heloc"] } })],
      facts: facts({ loanType: "cashout" }),
    });
    expect(out.considered[0].outcome).toBe("condition_failed");
  });
});

describe("triggers", () => {
  it("no_inbound_since fires at the threshold, not before", () => {
    const wf = workflow({ trigger_config: { days: 2 } });
    expect(matchTrigger(wf, facts({ lastInboundAt: ago(1) }), NOW).matched).toBe(false);
    expect(matchTrigger(wf, facts({ lastInboundAt: ago(2) }), NOW).matched).toBe(true);
    expect(matchTrigger(wf, facts({ lastInboundAt: ago(9) }), NOW).matched).toBe(true);
  });

  it("no_inbound_since measures from stage entry when they never replied", () => {
    const wf = workflow({ trigger_config: { days: 2 } });
    const never = facts({ lastInboundAt: null, stageChangedAt: ago(4) });
    const m = matchTrigger(wf, never, NOW);
    expect(m.matched).toBe(true);
    expect(m.snapshot.measured_from).toBe(never.stageChangedAt);
  });

  it("inbound_received needs an actual new reply", () => {
    const wf = workflow({ trigger_type: "inbound_received", trigger_config: {} });
    expect(matchTrigger(wf, facts({ hasNewInbound: false }), NOW).matched).toBe(false);
    expect(matchTrigger(wf, facts({ hasNewInbound: true }), NOW).matched).toBe(true);
  });

  it("classification_match compares the named lead_state field", () => {
    const wf = workflow({
      trigger_type: "classification_match",
      trigger_config: { field: "pitch_response", value: "competitor" },
    });
    expect(matchTrigger(wf, facts(), NOW).matched).toBe(false);
    expect(
      matchTrigger(wf, facts({ leadState: leadState({ pitch_response: "competitor" }) }), NOW)
        .matched
    ).toBe(true);
  });

  it("classification_match cannot fire on a lead never classified", () => {
    const wf = workflow({
      trigger_type: "classification_match",
      trigger_config: { field: "pitch_response", value: "no_response" },
    });
    const m = matchTrigger(wf, facts({ leadState: null }), NOW);
    expect(m.matched).toBe(false);
    expect(m.reason).toContain("never been classified");
  });

  it("stage_changed fires on entering, and only on a real move", () => {
    const wf = workflow({
      trigger_type: "stage_changed",
      trigger_config: { stage: "quoted_follow_up", direction: "into" },
    });
    expect(
      matchTrigger(wf, facts({ previousStage: "needs_quote", stage: "quoted_follow_up" }), NOW)
        .matched
    ).toBe(true);
    // A routine sweep with no move must not fire it.
    expect(matchTrigger(wf, facts({ previousStage: null }), NOW).matched).toBe(false);
    // Re-assigning the same stage is not a change.
    expect(
      matchTrigger(wf, facts({ previousStage: "quoted_follow_up", stage: "quoted_follow_up" }), NOW)
        .matched
    ).toBe(false);
  });

  it("days_in_stage will not guess when the stage entry time is unknown", () => {
    const wf = workflow({ trigger_type: "days_in_stage", trigger_config: { days: 2 } });
    const m = matchTrigger(wf, facts({ stageChangedAt: null }), NOW);
    expect(m.matched).toBe(false);
    expect(m.reason).toContain("unknown");
  });

  it("refuses a misconfigured trigger rather than firing on a default", () => {
    const wf = workflow({ trigger_config: {} });
    expect(matchTrigger(wf, facts(), NOW).matched).toBe(false);
  });

  it("daysSince returns null rather than NaN for unusable input", () => {
    expect(daysSince(null, NOW)).toBeNull();
    expect(daysSince("nonsense", NOW)).toBeNull();
  });
});

describe("message-causing actions", () => {
  it("counts a campaign handoff as a send", () => {
    // 4.4: "A campaign handoff is a send." Enrolment starts a live sequence.
    expect(causesMessage("add_to_bonzo_campaign")).toBe(true);
  });

  it("does not count internal-only actions", () => {
    expect(causesMessage("create_task")).toBe(false);
    expect(causesMessage("notify_telegram")).toBe(false);
    expect(causesMessage("move_stage")).toBe(false);
  });
});
