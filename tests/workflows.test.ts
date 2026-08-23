import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  evaluateWorkflows,
  hardStopReason,
  verifyStillValid,
  conditionsPass,
  causesMessage,
} from "@/lib/workflows/evaluate";
import { matchTrigger, daysSince } from "@/lib/workflows/triggers";
import { needsApproval, workflowMode, type LeadFacts, type Workflow } from "@/lib/workflows/types";
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
    auto_approve: false,
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

  /*
   * The bug this guards: measuring from the last reply alone fires the 2-day
   * handoff the instant a lead is pitched, if they happened to have been quiet
   * before the pitch. A freshly quoted lead has not gone quiet — they have not
   * had a chance to answer yet.
   */
  it("no_inbound_since measures from the pitch, not from older silence", () => {
    const wf = workflow({ trigger_config: { days: 2 } });
    // Replied 5 days ago, pitched (entered the stage) today.
    const justPitched = facts({ lastInboundAt: ago(5), stageChangedAt: ago(0) });
    const m = matchTrigger(wf, justPitched, NOW);
    expect(m.matched).toBe(false);
    expect(m.snapshot).toEqual({});
  });

  it("no_inbound_since fires two days after the pitch, not after the old reply", () => {
    const wf = workflow({ trigger_config: { days: 2 } });
    const quiet = facts({ lastInboundAt: ago(5), stageChangedAt: ago(2) });
    const m = matchTrigger(wf, quiet, NOW);
    expect(m.matched).toBe(true);
    expect(m.snapshot.measured_from).toBe(quiet.stageChangedAt);
  });

  it("no_inbound_since still measures from a reply that came after the pitch", () => {
    // They answered the quote, then went quiet again. The clock restarts.
    const wf = workflow({ trigger_config: { days: 2 } });
    const repliedAfter = facts({ lastInboundAt: ago(3), stageChangedAt: ago(9) });
    const m = matchTrigger(wf, repliedAfter, NOW);
    expect(m.matched).toBe(true);
    expect(m.snapshot.measured_from).toBe(repliedAfter.lastInboundAt);
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

/*
 * The two seed workflows (4.6), exactly as 20260822000002 creates them.
 *
 * They are tested together because the interesting behaviour is the
 * interaction: the park has to beat the handoff on the evaluation where a lead
 * has just been pitched, or a fresh lead is handed to a cold campaign the
 * moment it arrives.
 */
describe("seed workflows", () => {
  const park = workflow({
    id: "wf-park",
    name: "Park in No Drip while I work them",
    trigger_type: "stage_changed",
    trigger_config: { stage: "quoted_follow_up", direction: "into" },
    action_type: "add_to_bonzo_campaign",
    action_config: { campaign_id: 122735 },
    priority: 10,
  });

  const handoff = workflow({
    id: "wf-handoff",
    name: "Hand off after 2 quiet days",
    trigger_type: "no_inbound_since",
    trigger_config: { days: 2 },
    conditions: { stage: ["quoted_follow_up"] },
    action_type: "add_to_bonzo_campaign",
    action_config: { campaign_id: 43998 },
    priority: 100,
  });

  const seeds = [park, handoff];

  it("parks a freshly pitched lead rather than handing it off", () => {
    // The lead last replied five days ago and was pitched today. Both rules
    // could look applicable; only the park is correct.
    const justPitched = facts({
      previousStage: "needs_quote",
      stage: "quoted_follow_up",
      stageChangedAt: ago(0),
      lastInboundAt: ago(5),
    });

    const out = evaluate({ workflows: seeds, facts: justPitched });
    expect(out.fired).toBe(true);
    if (!out.fired) return;
    expect(out.workflow.id).toBe("wf-park");
    expect(out.workflow.action_config.campaign_id).toBe(122735);
  });

  it("hands off two quiet days after the pitch", () => {
    const goneQuiet = facts({
      previousStage: null,
      stageChangedAt: ago(2),
      lastInboundAt: ago(5),
    });

    const out = evaluate({ workflows: seeds, facts: goneQuiet });
    expect(out.fired).toBe(true);
    if (!out.fired) return;
    expect(out.workflow.id).toBe("wf-handoff");
    expect(out.workflow.action_config.campaign_id).toBe(43998);
  });

  it("does not hand off a lead who answered the quote yesterday", () => {
    const answered = facts({
      previousStage: null,
      stageChangedAt: ago(6),
      lastInboundAt: ago(1),
    });
    expect(evaluate({ workflows: seeds, facts: answered }).fired).toBe(false);
  });

  it("both require approval, so neither messages anyone unattended", () => {
    for (const w of seeds) expect(w.requires_approval).toBe(true);
  });

  /*
   * Read the migration itself rather than a fixture.
   *
   * The fixtures above set enabled=true so trigger matching can be tested at
   * all, which means they prove nothing about how the seeds actually ship.
   * 4.4 calls dry-run non-optional and Eddie intends to watch these for days
   * before trusting them — so what matters is that the SQL creates them off,
   * in dry-run, and asking first. This fails if anyone edits that.
   */
  it("the migration creates them off, in dry-run, and approval-required", () => {
    const sql = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20260822000002_seed_workflows.sql"),
      "utf8"
    );

    // Two inserts, each with the same literal block: enabled=false, dry_run=true.
    const insertBlocks = sql.match(/^\s*false,\s*\n\s*true,\s*$/gm);
    expect(insertBlocks).toHaveLength(2);

    // Neither may ship enabled.
    expect(sql).not.toMatch(/^\s*true,\s*\n\s*false,\s*$/m);

    // Both campaign ids, both priorities, and approval-required on each.
    expect(sql).toContain("122735");
    expect(sql).toContain("43998");
    expect(sql.match(/^\s*true,\s*\n\s*10\s*$/m)).toBeTruthy();
    expect(sql.match(/^\s*true,\s*\n\s*100\s*$/m)).toBeTruthy();
  });

  it("the migration guards both inserts so re-running is safe", () => {
    const sql = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20260822000002_seed_workflows.sql"),
      "utf8"
    );
    // Production's migration history was originally empty; everything here
    // has to survive being applied more than once.
    expect(sql.match(/where not exists/gi)).toHaveLength(2);
  });

  it("stops entirely once the lead converts off the stage", () => {
    // D4: Eddie moving them to App In is the signal to stop chasing.
    const converted = facts({ stage: "app_in", stageChangedAt: ago(2), lastInboundAt: ago(5) });
    expect(evaluate({ workflows: seeds, facts: converted }).fired).toBe(false);
  });
});

/*
 * Phase 8 D4 — the handoff must not fire when the two-day window produced a
 * real response.
 *
 * This is the highest-stakes condition in the app. The rule messages a client
 * under Eddie's name, and the failure modes are asymmetric in the way D4
 * describes: dumping an engaged lead into a generic campaign is much worse
 * than leaving a dead one to be handed off by hand.
 */
describe("handoff suppression on pitch_response", () => {
  const suppressed = workflow({
    conditions: { pitch_response: ["no_response"] },
  });

  it("fires on no_response, which is the whole point of the rule", () => {
    const out = evaluate({
      workflows: [suppressed],
      facts: facts({ leadState: leadState({ pitch_response: "no_response" }) }),
    });
    expect(out.fired).toBe(true);
  });

  it.each([
    "soft_no",
    "price_objection",
    "timing_objection",
    "competitor",
    "needs_info",
    "positive_intent",
    "converted_signal",
  ] as const)("does not fire on %s — that is a live conversation", (response) => {
    const out = evaluate({
      workflows: [suppressed],
      facts: facts({ leadState: leadState({ pitch_response: response }) }),
    });
    expect(out.fired).toBe(false);
  });

  /*
   * An unclassified lead fails the condition rather than passing it. Firing on
   * a lead whose reaction to the quote has never been read would be acting on
   * an absence of evidence in the one direction the spec says is worse.
   */
  it("does not fire on a lead with no classification at all", () => {
    const out = evaluate({
      workflows: [suppressed],
      facts: facts({ leadState: null }),
    });
    expect(out.fired).toBe(false);
  });

  it("says why it did not fire, rather than going quiet", () => {
    const out = evaluate({
      workflows: [suppressed],
      facts: facts({ leadState: leadState({ pitch_response: "price_objection" }) }),
    });
    const considered = out.considered.find((c) => c.workflowId === suppressed.id);
    expect(considered?.reason ?? "").toMatch(/price_objection/);
  });

  it("can be widened without touching code", () => {
    const wider = workflow({
      conditions: { pitch_response: ["no_response", "soft_no"] },
    });
    const out = evaluate({
      workflows: [wider],
      facts: facts({ leadState: leadState({ pitch_response: "soft_no" }) }),
    });
    expect(out.fired).toBe(true);
  });

  /*
   * The Phase 7 evidence gate stays and takes precedence. It downgrades a
   * hand_off recommendation to follow_up when the quote backing it was not
   * found in the thread — but the 2-day rule fires on elapsed time, not on the
   * recommendation, so what actually protects a lead here is that a discarded
   * read falls back to no_response at low confidence. That fallback is what
   * makes this condition safe rather than a second guess at the same thing.
   */
  it("still fires for a lead whose read was discarded back to no_response", () => {
    const out = evaluate({
      workflows: [suppressed],
      facts: facts({
        leadState: leadState({
          pitch_response: "no_response",
          evidence: null,
          evidence_confidence: "low",
        }),
      }),
    });
    expect(out.fired).toBe(true);
  });
});

/*
 * Phase 8 D6 — auto_approve, and why it is a second flag.
 */
describe("needsApproval", () => {
  it("asks when the action is consequential and the rule is not trusted", () => {
    expect(needsApproval({ requires_approval: true, auto_approve: false })).toBe(true);
  });

  it("does not ask once the rule is trusted", () => {
    expect(needsApproval({ requires_approval: true, auto_approve: true })).toBe(false);
  });

  it("does not ask when the action never needed approval", () => {
    expect(needsApproval({ requires_approval: false, auto_approve: false })).toBe(false);
  });

  it("plans an auto-approved live rule straight to executed", () => {
    const out = evaluate({
      workflows: [workflow({ dry_run: false, requires_approval: true, auto_approve: true })],
    });
    expect(out.fired).toBe(true);
    if (out.fired) expect(out.plannedStatus).toBe("executed");
  });

  it("still plans a live rule that is not trusted to pending_approval", () => {
    const out = evaluate({
      workflows: [workflow({ dry_run: false, requires_approval: true, auto_approve: false })],
    });
    expect(out.fired).toBe(true);
    if (out.fired) expect(out.plannedStatus).toBe("pending_approval");
  });

  /*
   * Dry run outranks trust. A rule Eddie is still watching must not start
   * acting because he also marked it auto-approve — the ladder is the outer
   * control and approval is the inner one.
   */
  it("keeps an auto-approved rule in dry run harmless", () => {
    const out = evaluate({
      workflows: [workflow({ dry_run: true, requires_approval: true, auto_approve: true })],
    });
    expect(out.fired).toBe(true);
    if (out.fired) expect(out.plannedStatus).toBe("dry_run");
  });
});

/*
 * Enrol on quote.
 *
 * "Responded (NEW Quoted)" does not touch a prospect until day 3 — the
 * two-day wait is inside the sequence. Parking first and handing off after two
 * quiet days made that wait be served twice, so a lead heard nothing from
 * Bonzo for four days where Eddie wanted two.
 *
 * Asserted against the migration text because the rules are data, not code:
 * the engine has no opinion about which campaign a rule targets, so the only
 * place this decision exists is the file that writes it.
 */
describe("the enrol-on-quote migration", () => {
  const sql = readFileSync(
    resolve(process.cwd(), "supabase/migrations/20260823000006_enroll_on_quote.sql"),
    "utf8"
  );

  it("repoints the stage_changed rule at the sending campaign", () => {
    expect(sql).toContain("198426");
    expect(sql).toMatch(/trigger_type = 'stage_changed'/);
    // Guarded on the old id, so a rule already repointed by hand is untouched.
    expect(sql).toContain("'122735'");
  });

  it("revokes auto-approve, because the reason for granting it is gone", () => {
    /*
     * D6 granted it on one argument: the target could not message anyone. A
     * rule that enrols a lead into a sending campaign without being asked is
     * exactly what requires_approval exists for.
     */
    expect(sql).toMatch(/set auto_approve = false/);
  });

  it("switches the now-redundant handoff off rather than deleting it", () => {
    expect(sql).toMatch(/set enabled = false/);
    expect(sql).not.toMatch(/delete\s+from\s+workflows/i);
  });

  it("never enables anything", () => {
    // The one thing this file must not do. Both rules stay where Eddie put
    // them on the ladder.
    expect(sql).not.toMatch(/set enabled = true/);
    expect(sql).not.toMatch(/set dry_run = false/);
  });

  it("says out loud what the change costs", () => {
    // The D4 suppression lived on the handoff rule and kept engaged leads out
    // of a sending campaign. Enrolling on arrival happens before anyone can
    // reply, so that protection no longer has anything to attach to.
    expect(sql).toMatch(/stop-on-response/);
  });
});
