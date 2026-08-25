import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { touchDue, scheduleTouches } from "@/lib/agents/schedule";
import { normalizePlan, MIN_STEPS, MAX_STEPS } from "@/lib/agents/plan";
import type { AgentPlan } from "@/lib/agents/types";

const NOW = new Date("2026-08-25T18:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function input(over: Partial<Parameters<typeof touchDue>[0]> = {}) {
  return {
    agentStatus: "active" as const,
    touchStatus: "pending" as const,
    dueAt: hoursAgo(1),
    activatedAt: hoursAgo(72),
    lastMessageAt: hoursAgo(30),
    lastInboundAt: hoursAgo(90),
    minHoursSinceLastMessage: 6,
    hasPendingCard: false,
    draftsGenerated: [] as string[],
    now: NOW,
    timeZone: "America/Los_Angeles",
    ...over,
  };
}

describe("touchDue", () => {
  it("fires a touch that is due on a quiet thread", () => {
    expect(touchDue(input()).due).toBe(true);
  });

  it("waits until the due time", () => {
    const out = touchDue(input({ dueAt: new Date(NOW.getTime() + 7_200_000).toISOString() }));
    expect(out.due).toBe(false);
    expect(out.reason).toMatch(/not due for/);
  });

  it.each(["draft", "paused", "completed", "retired"] as const)(
    "does nothing while the agent is %s",
    (status) => {
      const out = touchDue(input({ agentStatus: status }));
      expect(out.due).toBe(false);
      expect(out.reason).toContain(status);
    }
  );

  it("never puts a second card on the phone", () => {
    // Two drafts for one lead with no way to tell which Send applies to is the
    // worst-feeling failure this system can produce.
    const out = touchDue(input({ hasPendingCard: true }));
    expect(out.due).toBe(false);
    expect(out.reason).toMatch(/still waiting/);
  });

  it("stops when they replied after the agent was activated", () => {
    /*
     * The backstop for the gap between a reply landing in Bonzo and the
     * refresh noticing it. Without this a touch could go out on top of a
     * conversation that started four minutes ago.
     */
    const out = touchDue(input({ activatedAt: hoursAgo(72), lastInboundAt: hoursAgo(2) }));
    expect(out.due).toBe(false);
    expect(out.reason).toMatch(/replied/);
  });

  it("ignores a reply from before the agent existed", () => {
    // That reply is why Eddie deployed the agent. It is not a reason to stop.
    expect(touchDue(input({ activatedAt: hoursAgo(24), lastInboundAt: hoursAgo(90) })).due).toBe(
      true
    );
  });

  it("holds off when anyone messaged recently, including Eddie", () => {
    const out = touchDue(input({ lastMessageAt: hoursAgo(2) }));
    expect(out.due).toBe(false);
    expect(out.reason).toMatch(/last message was 2\.0h ago/);
  });

  it("allows only one agent draft per lead per day", () => {
    const out = touchDue(input({ draftsGenerated: [hoursAgo(3)] }));
    expect(out.due).toBe(false);
    expect(out.reason).toMatch(/already drafted/);
  });

  it("counts days locally, so a draft late last night does not block this morning", () => {
    // 30 hours ago is the previous local day in Los Angeles.
    expect(touchDue(input({ draftsGenerated: [hoursAgo(30)] })).due).toBe(true);
  });
});

describe("scheduleTouches", () => {
  it("counts days from activation, not from deployment", () => {
    const plan: AgentPlan = {
      summary: "s",
      steps: [
        { step: 1, day: 1, hypothesis: "risk", angle: "a", rationale: "r" },
        { step: 2, day: 4, hypothesis: "money", angle: "b", rationale: "r" },
      ],
    };
    const out = scheduleTouches(plan, new Date("2026-08-25T00:00:00Z"));
    expect(out[0].due_at).toBe("2026-08-26T00:00:00.000Z");
    expect(out[1].due_at).toBe("2026-08-29T00:00:00.000Z");
  });
});

describe("normalizePlan", () => {
  const step = (over: Record<string, unknown> = {}) => ({
    step: 1,
    day: 1,
    hypothesis: "risk" as const,
    angle: "ask whether the cost or the commitment is the problem",
    rationale: "r",
    ...over,
  });

  it("orders by day and renumbers", () => {
    const out = normalizePlan(
      { summary: "s", steps: [step({ day: 6, step: 9 }), step({ day: 2, step: 4 })] } as AgentPlan,
      14
    );
    expect(out.steps.map((s) => [s.step, s.day])).toEqual([
      [1, 2],
      [2, 6],
    ]);
  });

  it("never schedules a touch on day 0", () => {
    // Day 0 fires the instant it is activated, on top of whatever conversation
    // prompted Eddie to deploy in the first place.
    const out = normalizePlan({ summary: "s", steps: [step({ day: 0 })] } as AgentPlan, 14);
    expect(out.steps[0].day).toBe(1);
  });

  it("pushes a collision later rather than merging it", () => {
    // Two touches on one day breaks the one-a-day rule; the second would be
    // cancelled on the day anyway.
    const out = normalizePlan(
      { summary: "s", steps: [step({ day: 3 }), step({ day: 3 })] } as AgentPlan,
      14
    );
    expect(out.steps.map((s) => s.day)).toEqual([3, 4]);
  });

  it("clamps past the sequence length", () => {
    const out = normalizePlan({ summary: "s", steps: [step({ day: 99 })] } as AgentPlan, 14);
    expect(out.steps[0].day).toBe(14);
  });

  it("drops a step with no angle", () => {
    // A step with no angle is a nudge, which is the thing this design exists
    // to avoid. Better absent than sent to Eddie as filler.
    const out = normalizePlan(
      { summary: "s", steps: [step(), step({ day: 5, angle: "   " })] } as AgentPlan,
      14
    );
    expect(out.steps).toHaveLength(1);
  });

  it("falls back to an honest 'unknown' hypothesis", () => {
    const out = normalizePlan(
      { summary: "s", steps: [step({ hypothesis: "vibes" })] } as unknown as AgentPlan,
      14
    );
    expect(out.steps[0].hypothesis).toBe("unknown");
  });

  it("never returns more than the maximum", () => {
    const many = Array.from({ length: 12 }, (_, i) => step({ day: i + 1 }));
    const out = normalizePlan({ summary: "s", steps: many } as AgentPlan, 30);
    expect(out.steps.length).toBeLessThanOrEqual(MAX_STEPS);
    expect(MAX_STEPS).toBeGreaterThan(MIN_STEPS);
  });
});

/*
 * The plan schema has to be one the API will actually accept.
 *
 * Structured-output schemas reject `minItems` values other than 0 or 1, with a
 * 400 raised before the request runs — so the first real deploy failed on a
 * schema that had never been exercised. The step floor lives in code instead,
 * which is where it was always enforced anyway.
 */
describe("the plan schema stays inside the API's constraints", () => {
  const source = readFileSync(resolve(process.cwd(), "lib/agents/plan.ts"), "utf8");

  it("does not constrain minItems", () => {
    // The key, not the word — the comment above the schema explains why it is
    // absent and would otherwise match.
    expect(source).not.toMatch(/minItems\s*:/);
  });

  it("still enforces the step floor after the call", () => {
    // buildPlan throws when fewer than MIN_STEPS survive normalisation, so
    // dropping the schema constraint loses nothing.
    expect(source).toMatch(/plan\.steps\.length < MIN_STEPS/);
  });
});
