import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseLoanAmount, describeAction, summariseSnapshot } from "@/lib/workflows/run";
import {
  parseWorkflowCallback,
  isWorkflowCallback,
} from "@/lib/telegram/workflow-handlers";
import type { Workflow } from "@/lib/workflows/types";
import type { Contact } from "@/types/db";

function workflow(over: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf-1",
    user_id: "user-1",
    name: "2-day handoff",
    enabled: true,
    dry_run: false,
    trigger_type: "no_inbound_since",
    trigger_config: { days: 2 },
    conditions: {},
    action_type: "add_to_bonzo_campaign",
    action_config: { campaign_id: 43998 },
    requires_approval: false,
    auto_approve: false,
    priority: 100,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    ...over,
  };
}

function contact(over: Partial<Contact> = {}): Contact {
  return {
    id: "contact-1",
    user_id: "user-1",
    name: "Dana Whitfield",
    loan_type: "cashout",
    crm: "bonzo",
    stage: "quoted_follow_up",
    position: 1000,
    adverse_reason: null,
    notes: null,
    bonzo_prospect_id: 5150,
    bonzo_email: "d@example.com",
    insights_enabled: true,
    phone: null,
    stage_changed_at: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    ...over,
  };
}

describe("parseLoanAmount", () => {
  it("reads Bonzo's formatted strings", () => {
    expect(parseLoanAmount("$412,500.00")).toBe(412500);
    expect(parseLoanAmount("250000")).toBe(250000);
    expect(parseLoanAmount(250000)).toBe(250000);
  });

  it("returns null rather than 0 for junk", () => {
    // 0 would silently pass a "minimum amount" filter as "below the minimum"
    // rather than "unknown", which is a different and wrong decision.
    expect(parseLoanAmount(null)).toBeNull();
    expect(parseLoanAmount("")).toBeNull();
    expect(parseLoanAmount("n/a")).toBeNull();
    expect(parseLoanAmount(undefined)).toBeNull();
  });
});

describe("callback parsing", () => {
  it("recognises its own callbacks and rejects the queue's", () => {
    expect(isWorkflowCallback("wa:run-1")).toBe(true);
    expect(isWorkflowCallback("wk:run-1")).toBe(true);
    expect(isWorkflowCallback("wr:run-1")).toBe(true);
    // The daily-queue codes must not be swallowed by this handler.
    expect(isWorkflowCallback("qs:item-1")).toBe(false);
    expect(isWorkflowCallback("qe:item-1")).toBe(false);
    expect(isWorkflowCallback(undefined)).toBe(false);
    expect(isWorkflowCallback("garbage")).toBe(false);
  });

  it("extracts the run id", () => {
    expect(parseWorkflowCallback("wa:run-abc")).toEqual({ action: "wa", runId: "run-abc" });
  });
});

describe("describeAction", () => {
  it("names the campaign when known, falling back to the id", () => {
    expect(describeAction(workflow(), "Quoted - Auto Follow up")).toContain(
      "Quoted - Auto Follow up"
    );
    expect(describeAction(workflow())).toContain("43998");
  });

  it("describes every action type without throwing", () => {
    const types = [
      workflow({ action_type: "move_stage", action_config: { stage: "app_in" } }),
      workflow({ action_type: "mark_adverse", action_config: { reason: "not_interested" } }),
      workflow({ action_type: "notify_telegram", action_config: { message: "gone quiet" } }),
      workflow({ action_type: "create_task", action_config: { title: "call them" } }),
      workflow({ action_type: "queue_follow_up", action_config: {} }),
    ];
    for (const w of types) expect(describeAction(w)).toBeTruthy();
  });
});

describe("summariseSnapshot", () => {
  it("turns a trigger snapshot into one readable line", () => {
    expect(summariseSnapshot({ days_since_inbound: 3 })).toContain("3 days");
    expect(summariseSnapshot({ from: "needs_quote", to: "quoted_follow_up" })).toContain("→");
    expect(summariseSnapshot({ field: "pitch_response", actual: "competitor" })).toContain(
      "competitor"
    );
  });

  it("never returns empty, so a card is never blank about why", () => {
    expect(summariseSnapshot({})).toBeTruthy();
  });
});

/*
 * The promise dry-run rests on: zero Bonzo calls. Eddie watches a workflow for
 * days before trusting it, and a single leaked call makes that observation
 * worthless.
 */
describe("executeAction refuses anything but a planned execution", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("refuses a dry-run and touches nothing", async () => {
    const moveProspectToCampaign = vi.fn();
    const getProspect = vi.fn();
    vi.doMock("@/lib/bonzo/client", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/bonzo/client")>()),
      moveProspectToCampaign,
      getProspect,
    }));

    const { executeAction } = await import("@/lib/workflows/execute");
    const result = await executeAction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: {} as any,
      workflow: workflow(),
      contact: contact(),
      plannedStatus: "dry_run",
    });

    expect(result.ok).toBe(false);
    expect(moveProspectToCampaign).not.toHaveBeenCalled();
    expect(getProspect).not.toHaveBeenCalled();
  });

  it("refuses a pending approval, which has not been approved yet", async () => {
    const moveProspectToCampaign = vi.fn();
    vi.doMock("@/lib/bonzo/client", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/bonzo/client")>()),
      moveProspectToCampaign,
    }));

    const { executeAction } = await import("@/lib/workflows/execute");
    const result = await executeAction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: {} as any,
      workflow: workflow(),
      contact: contact(),
      plannedStatus: "pending_approval",
    });

    expect(result.ok).toBe(false);
    expect(moveProspectToCampaign).not.toHaveBeenCalled();
  });
});

describe("campaign handoff", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function run(prospect: Record<string, unknown> | null) {
    const moveProspectToCampaign = vi.fn(async () => undefined);
    vi.doMock("@/lib/bonzo/client", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/bonzo/client")>()),
      getProspect: vi.fn(async () => prospect),
      moveProspectToCampaign,
    }));
    const { executeAction } = await import("@/lib/workflows/execute");
    const result = await executeAction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: {} as any,
      workflow: workflow(),
      contact: contact(),
      plannedStatus: "executed",
    });
    return { result, moveProspectToCampaign };
  }

  it("records the displaced campaign so the move can be undone", async () => {
    // Enrolment REPLACES. Without this the previous nurture sequence is lost.
    const { result, moveProspectToCampaign } = await run({
      id: 5150,
      campaigns: [{ id: 198426, name: "Responded (NEW Quoted)" }],
      opt_outs: [],
    });

    expect(result.ok).toBe(true);
    expect(moveProspectToCampaign).toHaveBeenCalledWith(5150, 43998);
    expect(result.ok && result.displaced).toEqual({
      campaign_id: 198426,
      campaign_name: "Responded (NEW Quoted)",
    });
  });

  it("refuses an opted-out prospect and makes no Bonzo write", async () => {
    const { result, moveProspectToCampaign } = await run({
      id: 5150,
      campaigns: [],
      opt_outs: ["sms"],
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("opted out");
    expect(moveProspectToCampaign).not.toHaveBeenCalled();
  });

  it("refuses a DNC prospect", async () => {
    const { result, moveProspectToCampaign } = await run({
      id: 5150,
      campaigns: [],
      opt_outs: [],
      do_not_call: true,
    });
    expect(result.ok).toBe(false);
    expect(moveProspectToCampaign).not.toHaveBeenCalled();
  });

  it("refuses when the prospect cannot be read rather than enrolling blind", async () => {
    const { result, moveProspectToCampaign } = await run(null);
    expect(result.ok).toBe(false);
    expect(moveProspectToCampaign).not.toHaveBeenCalled();
  });

  it("handles a prospect in no campaign, recording null displaced", async () => {
    const { result } = await run({ id: 5150, campaigns: [], opt_outs: [] });
    expect(result.ok).toBe(true);
    expect(result.ok && result.displaced).toBeNull();
  });

  it("refuses a contact with no linked Bonzo prospect", async () => {
    vi.doMock("@/lib/bonzo/client", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/bonzo/client")>()),
      getProspect: vi.fn(),
      moveProspectToCampaign: vi.fn(),
    }));
    const { executeAction } = await import("@/lib/workflows/execute");
    const result = await executeAction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: {} as any,
      workflow: workflow(),
      contact: contact({ bonzo_prospect_id: null }),
      plannedStatus: "executed",
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("no linked Bonzo prospect");
  });
});
