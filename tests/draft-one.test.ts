import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BonzoCommunication, BonzoProspect } from "@/lib/bonzo/client";

/**
 * The retry policy (6A.3): attempt, validate, at most ONE corrective retry,
 * then surface regardless — flagged if it still fails. Never a loop.
 *
 * This is the cost guarantee for the one paid path in the phase, so it is
 * asserted against a mocked model rather than trusted from reading the code.
 */

const PROSPECT = {
  id: 1,
  mortgage: {
    loan_amount: "450,000",
    loan_program: "30 year fixed",
    credit_score: "720",
  },
} as unknown as BonzoProspect;

const COMMS: BonzoCommunication[] = [
  {
    id: 1,
    content: "Sent you the numbers: 6.5% on a 30 year, 2,845 a month.",
    direction: "outgoing",
    type: "sms",
    subject: null,
    status: null,
    created_at: "2026-08-22T18:00:00Z",
    user_name: null,
    source: null,
  },
  {
    id: 2,
    content: "That rate is higher than what my credit union quoted me.",
    direction: "incoming",
    type: "sms",
    subject: null,
    status: null,
    created_at: "2026-08-22T19:00:00Z",
    user_name: null,
    source: null,
  },
];

const GOOD =
  "Worth seeing that credit union quote in writing before you decide. Send it over and I'll show you where the 6.5% lands against it.";

function input(over: Record<string, unknown> = {}) {
  return {
    channel: "sms" as const,
    contactName: "Dana Reyes",
    brokerName: "Eddie Canvasser",
    brokerCompany: "E Mortgage Capital",
    prospect: PROSPECT,
    communications: COMMS,
    leadState: null,
    hoursSincePitch: 4,
    ...over,
  };
}

/** Queues up the model's replies, one per call. */
function mockModel(replies: string[]) {
  // Declared with an argument it does not read, so vi.fn records call
  // arguments — the assertions below inspect them, and a zero-argument
  // implementation would leave mock.calls typed as empty tuples.
  const callModel = vi.fn(async (opts: unknown) => {
    void opts;
    const text = replies.shift() ?? "";
    return {
      text,
      parsed: null,
      usage: {
        model: "claude-sonnet-5",
        input_tokens: 100,
        output_tokens: 50,
        latency_ms: 10,
      },
      stopReason: "end_turn",
      truncated: false,
    };
  });

  vi.doMock("@/lib/ai/models", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/ai/models")>()),
    callModel,
  }));

  return callModel;
}

describe("draftOne retry policy", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns a clean draft on the first call, and makes only one", async () => {
    const callModel = mockModel([GOOD]);
    const { draftOne } = await import("@/lib/ai/draft-one");

    const out = await draftOne(input());

    expect(out.validated).toBe(true);
    expect(out.attempts).toBe(1);
    expect(out.violations).toEqual([]);
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("retries exactly once when the first draft breaks a rule", async () => {
    const callModel = mockModel([
      "Just checking in on that 6.5% quote — any thoughts?",
      GOOD,
    ]);
    const { draftOne } = await import("@/lib/ai/draft-one");

    const out = await draftOne(input());

    expect(callModel).toHaveBeenCalledTimes(2);
    expect(out.attempts).toBe(2);
    expect(out.validated).toBe(true);
    expect(out.body).toBe(GOOD);
  });

  /*
   * The one that matters for cost. A validator that turns out to be too strict
   * must degrade into showing Eddie something flagged, never into spending
   * until a draft happens to pass.
   */
  it("surfaces a still-failing draft flagged rather than looping", async () => {
    const callModel = mockModel([
      "Just checking in on that 6.5% quote!!",
      "Circling back about the 6.5% credit union quote!!",
      // A third reply is queued and must never be reached.
      GOOD,
    ]);
    const { draftOne } = await import("@/lib/ai/draft-one");

    const out = await draftOne(input());

    expect(callModel).toHaveBeenCalledTimes(2);
    expect(out.attempts).toBe(2);
    expect(out.validated).toBe(false);
    expect(out.violations.length).toBeGreaterThan(0);
    // Surfaced, not swallowed — he still gets something to read.
    expect(out.body).toContain("Circling back");
  });

  it("puts the specific violations into the retry, not the whole rulebook", async () => {
    const callModel = mockModel(["Circling back on that 6.5% quote.", GOOD]);
    const { draftOne } = await import("@/lib/ai/draft-one");

    await draftOne(input());

    const second = callModel.mock.calls[1][0] as unknown as {
      messages: { role: string; content: string }[];
    };
    const correction = second.messages[second.messages.length - 1].content;
    expect(correction).toContain("circling back");
    expect(correction).not.toContain("HARD RULES");
  });

  it("treats a truncated response as a failure, not a short message", async () => {
    vi.doMock("@/lib/ai/models", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ai/models")>()),
      callModel: vi.fn(async () => ({
        text: "About that credit union quote, the 6.5% rate you asked about is",
        parsed: null,
        usage: {
          model: "claude-sonnet-5",
          input_tokens: 100,
          output_tokens: 50,
          latency_ms: 10,
        },
        stopReason: "max_tokens",
        truncated: true,
      })),
    }));
    const { draftOne } = await import("@/lib/ai/draft-one");

    const out = await draftOne(input());
    expect(out.validated).toBe(false);
    expect(out.violations.map((v) => v.rule)).toContain("truncated");
  });

  it("reports usage for every call it made, so spend is attributable", async () => {
    mockModel(["Circling back on the 6.5% quote.", GOOD]);
    const { draftOne } = await import("@/lib/ai/draft-one");

    const out = await draftOne(input());
    expect(out.usage).toHaveLength(2);
    expect(out.usage[0].model).toBe("claude-sonnet-5");
  });

  it("asks for temperature 0.3, and lets the model layer decide if it applies", async () => {
    /*
     * 6A.6 asks for temperature 0.3 on every drafting call. Sonnet 5 and
     * Opus 5 reject sampling parameters outright, so lib/ai/models.ts drops it
     * for those and tone is held by the validator instead. What this asserts
     * is that drafting asks — pinning an older model by env var then restores
     * the behaviour with no code change.
     */
    const callModel = mockModel([GOOD]);
    const { draftOne } = await import("@/lib/ai/draft-one");

    await draftOne(input());

    const call = callModel.mock.calls[0][0] as unknown as { temperature?: number };
    expect(call.temperature).toBe(0.3);
  });

  it("passes his own messages in as style exemplars, not a described style", async () => {
    const callModel = mockModel([GOOD]);
    const { draftOne } = await import("@/lib/ai/draft-one");

    await draftOne(input());

    const call = callModel.mock.calls[0][0] as unknown as {
      messages: { content: string }[];
    };
    expect(call.messages[0].content).toContain("HOW HE WRITES");
    expect(call.messages[0].content).toContain("Sent you the numbers");
  });

  it("tells the model to ask rather than guess when there is no loan file", async () => {
    const callModel = mockModel([GOOD]);
    const { draftOne } = await import("@/lib/ai/draft-one");

    await draftOne(input({ prospect: null }));

    const call = callModel.mock.calls[0][0] as unknown as {
      messages: { content: string }[];
    };
    expect(call.messages[0].content).toContain("Do not state any figure at all");
  });
});
