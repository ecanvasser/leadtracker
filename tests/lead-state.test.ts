import { describe, it, expect } from "vitest";
import {
  enforceLeadStateRules,
  quoteAppearsInHistory,
  stripLeadingDate,
  normalizeQuote,
  withObservedTimestamps,
  type LeadState,
} from "@/lib/insights/lead-state";

const HISTORY = [
  {
    content: "Hi, I applied last month but got denied because of my credit score.",
    direction: "inbound",
    created_at: "2026-07-10T16:00:00Z",
  },
  {
    content: "Understood. Let's revisit once the collection drops off.",
    direction: "outbound",
    created_at: "2026-07-10T17:00:00Z",
  },
  {
    content: "Sounds good, that's supposed to be this fall.",
    direction: "inbound",
    created_at: "2026-07-11T15:00:00Z",
  },
];

function state(overrides: Partial<LeadState> = {}): LeadState {
  return {
    lead_temp: "blocked",
    blocker: "credit",
    blocker_evidence: "got denied because of my credit score",
    blocker_confidence: "high",
    unblock_path: "Wait for the collection to age off, then re-pull.",
    unblock_trigger: "Collection drops off the report",
    last_inbound_at: null,
    last_outbound_at: null,
    recommended_action: "sms",
    why_now: "Denied on credit in July; collection expected to drop this fall.",
    suppress_until: null,
    ...overrides,
  };
}

describe("quote verification", () => {
  it("accepts a quote that is genuinely in the history", () => {
    expect(quoteAppearsInHistory("got denied because of my credit score", HISTORY)).toBe(true);
  });

  it("accepts a quote the model prefixed with a date", () => {
    expect(
      quoteAppearsInHistory("[2026-07-10] got denied because of my credit score", HISTORY)
    ).toBe(true);
  });

  it("tolerates differing whitespace and smart punctuation", () => {
    expect(quoteAppearsInHistory("Let's   revisit once the collection drops off.", HISTORY)).toBe(true);
    expect(quoteAppearsInHistory("Let’s revisit once the collection drops off.", HISTORY)).toBe(true);
  });

  it("rejects a paraphrase, however plausible", () => {
    // This is the failure mode: a confident, checkable-sounding claim that
    // nobody actually said.
    expect(quoteAppearsInHistory("my credit was too low to qualify", HISTORY)).toBe(false);
  });

  it("rejects a fabricated quote outright", () => {
    expect(quoteAppearsInHistory("I'm working with another lender now", HISTORY)).toBe(false);
  });

  it("rejects a quote too short to be meaningful", () => {
    expect(quoteAppearsInHistory("credit", HISTORY)).toBe(false);
  });

  it("rejects everything when there is no history at all", () => {
    expect(quoteAppearsInHistory("got denied because of my credit score", [])).toBe(false);
  });
});

describe("stripLeadingDate", () => {
  it("removes a bracketed date prefix", () => {
    expect(stripLeadingDate("[2026-07-10] got denied")).toBe("got denied");
  });

  it("removes a bare date with a colon", () => {
    expect(stripLeadingDate("2026-07-10: got denied")).toBe("got denied");
  });

  it("leaves a quote with no date prefix alone", () => {
    expect(stripLeadingDate("got denied")).toBe("got denied");
  });
});

describe("normalizeQuote", () => {
  it("collapses whitespace and lowercases", () => {
    expect(normalizeQuote("  Got   DENIED\n\nagain ")).toBe("got denied again");
  });

  it("normalizes dashes so an em dash matches a hyphen", () => {
    expect(normalizeQuote("credit—score")).toBe(normalizeQuote("credit-score"));
  });
});

// Rule 1: no inferred blockers without a quote.
describe("blocker evidence enforcement", () => {
  it("keeps a blocker backed by a real quote", () => {
    const { state: out, evidenceRejected } = enforceLeadStateRules(state(), HISTORY);
    expect(out.blocker).toBe("credit");
    expect(evidenceRejected).toBe(false);
  });

  it("discards a blocker whose quote is not in the history", () => {
    const { state: out, evidenceRejected } = enforceLeadStateRules(
      state({
        blocker: "competitor",
        blocker_evidence: "I already signed with another lender",
      }),
      HISTORY
    );
    expect(out.blocker).toBe("none");
    expect(out.blocker_evidence).toBeNull();
    expect(out.blocker_confidence).toBe("low");
    expect(evidenceRejected).toBe(true);
  });

  it("discards a blocker asserted with no quote at all", () => {
    const { state: out } = enforceLeadStateRules(
      state({ blocker: "income", blocker_evidence: null }),
      HISTORY
    );
    expect(out.blocker).toBe("none");
  });

  it("clears the unblock path when the blocker was discarded", () => {
    // The path was reasoning from a blocker that turned out to be invented.
    const { state: out } = enforceLeadStateRules(
      state({ blocker: "dti", blocker_evidence: "my debt ratio is too high" }),
      HISTORY
    );
    expect(out.unblock_path).toBeNull();
    expect(out.unblock_trigger).toBeNull();
  });

  it("never reports high confidence in a blocker of none", () => {
    const { state: out } = enforceLeadStateRules(
      state({ blocker: "none", blocker_evidence: null, blocker_confidence: "high" }),
      HISTORY
    );
    expect(out.blocker_confidence).toBe("low");
  });
});

// Rule 2: the engine must be allowed to recommend doing nothing.
describe("hold enforcement", () => {
  it("holds a blocked lead whose trigger has not fired", () => {
    const { state: out } = enforceLeadStateRules(
      state({ lead_temp: "blocked", recommended_action: "sms" }),
      HISTORY
    );
    expect(out.recommended_action).toBe("hold");
  });

  it("holds a stalled lead too", () => {
    const { state: out } = enforceLeadStateRules(
      state({ lead_temp: "stalled", recommended_action: "email" }),
      HISTORY
    );
    expect(out.recommended_action).toBe("hold");
  });

  it("leaves an in-market lead free to be contacted", () => {
    const { state: out } = enforceLeadStateRules(
      state({ lead_temp: "in_market", blocker: "none", blocker_evidence: null, recommended_action: "sms" }),
      HISTORY
    );
    expect(out.recommended_action).toBe("sms");
  });

  it("leaves a warming lead free to be contacted", () => {
    const { state: out } = enforceLeadStateRules(
      state({ lead_temp: "warming", blocker: "none", blocker_evidence: null, recommended_action: "call" }),
      HISTORY
    );
    expect(out.recommended_action).toBe("call");
  });

  it("holds any lead suppressed until a future date", () => {
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const { state: out } = enforceLeadStateRules(
      state({ lead_temp: "in_market", blocker: "none", blocker_evidence: null, recommended_action: "sms", suppress_until: future }),
      HISTORY
    );
    expect(out.recommended_action).toBe("hold");
  });

  it("ignores a suppression date that has already passed", () => {
    const past = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const { state: out } = enforceLeadStateRules(
      state({ lead_temp: "in_market", blocker: "none", blocker_evidence: null, recommended_action: "sms", suppress_until: past }),
      HISTORY
    );
    expect(out.recommended_action).toBe("sms");
  });

  it("holds even when the model asserted an unblock trigger in prose", () => {
    // Nothing in the system observes rate movements or credit events yet, so a
    // described trigger has not fired. Holding is the honest behaviour.
    const { state: out } = enforceLeadStateRules(
      state({
        lead_temp: "blocked",
        recommended_action: "sms",
        unblock_trigger: "rates drop below 6%",
      }),
      HISTORY
    );
    expect(out.recommended_action).toBe("hold");
  });
});

describe("withObservedTimestamps", () => {
  it("computes timestamps from the history rather than trusting the model", () => {
    const out = withObservedTimestamps(
      state({ last_inbound_at: "1999-01-01T00:00:00Z", last_outbound_at: "1999-01-01T00:00:00Z" }),
      HISTORY
    );
    expect(out.last_inbound_at).toBe("2026-07-11T15:00:00.000Z");
    expect(out.last_outbound_at).toBe("2026-07-10T17:00:00.000Z");
  });

  it("returns null for a direction with no messages", () => {
    const out = withObservedTimestamps(state(), [
      { direction: "outbound", created_at: "2026-08-01T00:00:00Z" },
    ]);
    expect(out.last_inbound_at).toBeNull();
    expect(out.last_outbound_at).toBe("2026-08-01T00:00:00.000Z");
  });

  it("handles an empty history", () => {
    const out = withObservedTimestamps(state(), []);
    expect(out.last_inbound_at).toBeNull();
    expect(out.last_outbound_at).toBeNull();
  });
});
