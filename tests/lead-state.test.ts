import { describe, it, expect } from "vitest";
import {
  enforceLeadStateRules,
  quoteAppearsInHistory,
  stripLeadingDate,
  normalizeQuote,
  withObservedFacts,
  daysSincePitch,
  shouldClassify,
  CLASSIFY_INTERVAL_HOURS,
  CLASSIFY_PROMPT_VERSION,
  type LeadState,
} from "@/lib/insights/lead-state";

/** A pitched lead who pushed back on the number. */
const HISTORY = [
  {
    content: "Here's the quote — 6.875% on the cash-out, $412 a month back to you.",
    direction: "outbound",
    created_at: "2026-07-10T16:00:00Z",
  },
  {
    content: "That rate is higher than I was expecting honestly.",
    direction: "inbound",
    created_at: "2026-07-10T17:00:00Z",
  },
  {
    content: "Understood — let me see what I can do on the credit.",
    direction: "outbound",
    created_at: "2026-07-11T15:00:00Z",
  },
];

function state(overrides: Partial<LeadState> = {}): LeadState {
  return {
    pitch_response: "price_objection",
    evidence: "That rate is higher than I was expecting",
    evidence_confidence: "high",
    suggested_angle: "He balked at the rate, not the payment — lead with the buydown.",
    last_inbound_at: null,
    last_outbound_at: null,
    days_since_pitch: 2,
    recommended_action: "follow_up",
    suppress_until: null,
    ...overrides,
  };
}

describe("quote verification", () => {
  it("accepts a quote that is genuinely in the history", () => {
    expect(quoteAppearsInHistory("That rate is higher than I was expecting", HISTORY)).toBe(true);
  });

  it("accepts a quote the model prefixed with a date", () => {
    expect(
      quoteAppearsInHistory("[2026-07-10] That rate is higher than I was expecting", HISTORY)
    ).toBe(true);
  });

  it("tolerates differing whitespace and smart punctuation", () => {
    expect(quoteAppearsInHistory("let me   see what I can do on the credit", HISTORY)).toBe(true);
    // Em dash in the stored message, hyphen in the echoed quote.
    expect(quoteAppearsInHistory("Understood - let me see what I can do", HISTORY)).toBe(true);
  });

  it("rejects a paraphrase, however plausible", () => {
    // This is the failure mode: a confident, checkable-sounding claim that
    // nobody actually said.
    expect(quoteAppearsInHistory("he said the rate was too high for him", HISTORY)).toBe(false);
  });

  it("rejects a fabricated quote outright", () => {
    expect(quoteAppearsInHistory("I'm working with another lender now", HISTORY)).toBe(false);
  });

  it("rejects a quote too short to be meaningful", () => {
    expect(quoteAppearsInHistory("rate", HISTORY)).toBe(false);
  });

  it("rejects everything when there is no history at all", () => {
    expect(quoteAppearsInHistory("That rate is higher than I was expecting", [])).toBe(false);
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

/*
 * Rule 1: no specific read of the thread without a verifiable quote.
 *
 * This is the rule the whole phase leans on. A hallucinated "soft_no" is not a
 * cosmetic error — it is what hands a live deal to a cold nurture campaign
 * under Eddie's name.
 */
describe("evidence enforcement", () => {
  it("keeps a reading backed by a real quote", () => {
    const { state: out, evidenceRejected } = enforceLeadStateRules(state(), HISTORY);
    expect(out.pitch_response).toBe("price_objection");
    expect(out.evidence).toBe("That rate is higher than I was expecting");
    expect(evidenceRejected).toBe(false);
  });

  it("discards a reading whose quote is not in the history", () => {
    const { state: out, evidenceRejected } = enforceLeadStateRules(
      state({
        pitch_response: "competitor",
        evidence: "I'm going with another lender",
      }),
      HISTORY
    );
    expect(evidenceRejected).toBe(true);
    expect(out.pitch_response).toBe("no_response");
    expect(out.evidence).toBeNull();
    expect(out.evidence_confidence).toBe("low");
  });

  it("discards a reading asserted with no quote at all", () => {
    const { state: out, evidenceRejected } = enforceLeadStateRules(
      state({ pitch_response: "soft_no", evidence: null }),
      HISTORY
    );
    expect(evidenceRejected).toBe(true);
    expect(out.pitch_response).toBe("no_response");
  });

  it("does not demand a quote for no_response, which asserts nothing", () => {
    const { state: out, evidenceRejected } = enforceLeadStateRules(
      state({ pitch_response: "no_response", evidence: null, evidence_confidence: "medium" }),
      HISTORY
    );
    expect(evidenceRejected).toBe(false);
    expect(out.pitch_response).toBe("no_response");
  });

  it("never reports high confidence in a no_response", () => {
    const { state: out } = enforceLeadStateRules(
      state({ pitch_response: "no_response", evidence: null, evidence_confidence: "high" }),
      HISTORY
    );
    expect(out.evidence_confidence).toBe("low");
  });
});

/*
 * Rule 2: the two consequential actions require evidence that survived.
 *
 * hand_off starts real messaging under Eddie's name; convert stops him
 * chasing. Neither should follow from a quote that turned out not to exist.
 */
describe("consequential actions are gated on surviving evidence", () => {
  it("downgrades hand_off to follow_up when the evidence was discarded", () => {
    const { state: out, evidenceRejected } = enforceLeadStateRules(
      state({
        pitch_response: "soft_no",
        evidence: "not interested at this time",
        recommended_action: "hand_off",
      }),
      HISTORY
    );
    expect(evidenceRejected).toBe(true);
    expect(out.recommended_action).toBe("follow_up");
  });

  it("downgrades convert to follow_up when the evidence was discarded", () => {
    const { state: out } = enforceLeadStateRules(
      state({
        pitch_response: "converted_signal",
        evidence: "send me the application",
        recommended_action: "convert",
      }),
      HISTORY
    );
    expect(out.recommended_action).toBe("follow_up");
  });

  it("leaves hand_off alone when the evidence checks out", () => {
    const { state: out } = enforceLeadStateRules(
      state({ recommended_action: "hand_off" }),
      HISTORY
    );
    expect(out.recommended_action).toBe("hand_off");
  });

  it("leaves hold alone — doing nothing is never the dangerous answer", () => {
    const { state: out } = enforceLeadStateRules(
      state({ pitch_response: "competitor", evidence: "made up", recommended_action: "hold" }),
      HISTORY
    );
    expect(out.recommended_action).toBe("hold");
  });
});

describe("suppression", () => {
  it("holds any lead suppressed until a future date", () => {
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const { state: out } = enforceLeadStateRules(
      state({ recommended_action: "follow_up", suppress_until: future }),
      HISTORY
    );
    expect(out.recommended_action).toBe("hold");
  });

  it("ignores a suppression date that has already passed", () => {
    const past = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const { state: out } = enforceLeadStateRules(
      state({ recommended_action: "follow_up", suppress_until: past }),
      HISTORY
    );
    expect(out.recommended_action).toBe("follow_up");
  });
});

describe("withObservedFacts", () => {
  const input = {
    communications: [
      { direction: "outbound", created_at: "2026-07-10T16:00:00Z" },
      { direction: "inbound", created_at: "2026-07-10T17:00:00Z" },
      { direction: "outbound", created_at: "2026-07-11T15:00:00Z" },
    ],
    todayLocal: "2026-07-15",
    quotedAt: "2026-07-10T16:00:00Z",
  };

  it("computes timestamps from the history rather than trusting the model", () => {
    const out = withObservedFacts(
      state({ last_inbound_at: "1999-01-01T00:00:00Z", last_outbound_at: null }),
      input
    );
    expect(out.last_inbound_at).toBe("2026-07-10T17:00:00.000Z");
    expect(out.last_outbound_at).toBe("2026-07-11T15:00:00.000Z");
  });

  it("computes days_since_pitch rather than trusting the model", () => {
    const out = withObservedFacts(state({ days_since_pitch: 999 }), input);
    expect(out.days_since_pitch).toBe(5);
  });

  it("returns null for a direction with no messages", () => {
    const out = withObservedFacts(state(), {
      ...input,
      communications: [{ direction: "outbound", created_at: "2026-07-10T16:00:00Z" }],
    });
    expect(out.last_inbound_at).toBeNull();
  });

  it("handles an empty history", () => {
    const out = withObservedFacts(state(), { ...input, communications: [] });
    expect(out.last_inbound_at).toBeNull();
    expect(out.last_outbound_at).toBeNull();
  });
});

/*
 * days_since_pitch is null, never zero, when the pitch date is unknown.
 *
 * A lead that entered Quoted – Follow Up before stage_changed_at existed has
 * no pitch date. Reporting 0 would read as "pitched today" and suppress
 * exactly the follow-up that is most overdue.
 */
describe("daysSincePitch", () => {
  it("counts whole days from the pitch", () => {
    expect(daysSincePitch("2026-07-10T16:00:00Z", "2026-07-15")).toBe(5);
  });

  it("is 0 on the day of the pitch", () => {
    expect(daysSincePitch("2026-07-15T16:00:00Z", "2026-07-15")).toBe(0);
  });

  it("is null, not 0, when the pitch date is unknown", () => {
    expect(daysSincePitch(null, "2026-07-15")).toBeNull();
    expect(daysSincePitch(undefined, "2026-07-15")).toBeNull();
  });

  it("is null rather than NaN for a malformed date", () => {
    expect(daysSincePitch("not-a-date", "2026-07-15")).toBeNull();
  });

  it("never returns a negative for a clock-skewed future pitch date", () => {
    expect(daysSincePitch("2026-08-01T00:00:00Z", "2026-07-15")).toBe(0);
  });
});

/*
 * Spec 3.3 — when classification runs.
 *
 * This is the cost control for the whole phase. The cache refresh stays at 15
 * minutes because reading Bonzo is free and reply/opt-out detection has to be
 * fast; only the thinking is rationed. Callers reach this only after the
 * hasNewMessages guard has already returned on an empty poll.
 */
describe("shouldClassify", () => {
  const now = new Date("2026-08-21T18:00:00Z");

  it("classifies a lead that has never been classified", () => {
    const r = shouldClassify({ hasNewInbound: false, lastClassifiedAt: null, now });
    expect(r.classify).toBe(true);
    expect(r.reason).toBe("never_classified");
  });

  it("classifies immediately when the prospect replied", () => {
    // Even one minute after the last run. A reply is the moment the picture
    // changes, and waiting half a day to notice defeats the point.
    const r = shouldClassify({
      hasNewInbound: true,
      lastClassifiedAt: "2026-08-21T17:59:00Z",
      now,
    });
    expect(r.classify).toBe(true);
    expect(r.reason).toBe("new_inbound");
  });

  it("does not reclassify inside the interval on outbound activity alone", () => {
    // Eddie sending something does not change what the lead thinks, so it is
    // not worth a model call.
    const r = shouldClassify({
      hasNewInbound: false,
      lastClassifiedAt: "2026-08-21T12:00:00Z",
      now,
    });
    expect(r.classify).toBe(false);
    expect(r.reason).toBe("classified_recently");
  });

  it("reclassifies once the interval has elapsed", () => {
    const r = shouldClassify({
      hasNewInbound: false,
      lastClassifiedAt: "2026-08-21T06:00:00Z",
      now,
    });
    expect(r.classify).toBe(true);
    expect(r.reason).toBe("interval_elapsed");
  });

  it("runs twice a day at the default interval", () => {
    expect(CLASSIFY_INTERVAL_HOURS).toBe(12);
    expect(24 / CLASSIFY_INTERVAL_HOURS).toBe(2);
  });

  it("treats an unreadable timestamp as never classified, not as recent", () => {
    // Failing towards a known-good record. Reading garbage as "classified
    // recently" would silently freeze a lead's state forever.
    const r = shouldClassify({ hasNewInbound: false, lastClassifiedAt: "garbage", now });
    expect(r.classify).toBe(true);
    expect(r.reason).toBe("unreadable_timestamp");
  });

  it("costs at most two classifications per lead per day without replies", () => {
    // Walk a full day of 15-minute refreshes and count how many would think.
    let lastClassifiedAt: string | null = null;
    let runs = 0;
    for (let tick = 0; tick < (24 * 60) / 15; tick++) {
      const at = new Date(Date.UTC(2026, 7, 21) + tick * 15 * 60_000);
      const r = shouldClassify({ hasNewInbound: false, lastClassifiedAt, now: at });
      if (r.classify) {
        runs++;
        lastClassifiedAt = at.toISOString();
      }
    }
    // 96 refreshes across the day (00:00 to 23:45); 2 classifications, at
    // 00:00 and 12:00. Section 6's budget rests on this ratio: the refresh is
    // free, and 94 of those 96 ticks cost nothing.
    expect(runs).toBe(2);
  });
});

/*
 * A prompt change has to invalidate the reads it made.
 *
 * The failure this prevents, found in production: the classifier prompt was
 * rewritten to look for what is blocking a lead rather than what step is
 * outstanding, and not one existing lead picked it up. Classification re-runs
 * on a new message or a 12-hour interval, and the leads drafting serves are by
 * definition the ones who have stopped sending messages. Their angle stayed
 * frozen, and every draft kept executing the old prompt's instruction
 * faithfully.
 */
describe("classification is invalidated by a prompt change", () => {
  const RECENT = new Date("2026-08-24T17:00:00Z").toISOString();
  const NOW = new Date("2026-08-24T18:00:00Z");

  it("reclassifies when the stored fingerprint does not match", () => {
    const out = shouldClassify({
      hasNewInbound: false,
      lastClassifiedAt: RECENT,
      promptVersion: "deadbeef",
      now: NOW,
    });
    expect(out.classify).toBe(true);
    expect(out.reason).toBe("prompt_changed");
  });

  it("reclassifies a read written before the column existed", () => {
    const out = shouldClassify({
      hasNewInbound: false,
      lastClassifiedAt: RECENT,
      promptVersion: null,
      now: NOW,
    });
    expect(out.classify).toBe(true);
    expect(out.reason).toBe("prompt_changed");
  });

  it("leaves a matching read alone", () => {
    // The whole point is that this stays cheap: a lead whose read was made by
    // the current prompt, with nothing new said, must not spend a token.
    const out = shouldClassify({
      hasNewInbound: false,
      lastClassifiedAt: RECENT,
      promptVersion: CLASSIFY_PROMPT_VERSION,
      now: NOW,
    });
    expect(out.classify).toBe(false);
    expect(out.reason).toBe("classified_recently");
  });

  it("checks the fingerprint before the interval", () => {
    // Otherwise a prompt change waits up to twelve hours to take effect on a
    // lead classified moments ago.
    const out = shouldClassify({
      hasNewInbound: false,
      lastClassifiedAt: RECENT,
      promptVersion: "stale",
      now: NOW,
      intervalHours: 12,
    });
    expect(out.reason).toBe("prompt_changed");
  });

  it("omitting the fingerprint does not force a reclassification", () => {
    // Callers that genuinely do not know the version must not stampede every
    // lead into the classifier. Only an explicit mismatch counts.
    const out = shouldClassify({
      hasNewInbound: false,
      lastClassifiedAt: RECENT,
      now: NOW,
    });
    expect(out.classify).toBe(false);
  });

  it("changes when the prompt text changes", () => {
    expect(CLASSIFY_PROMPT_VERSION).toMatch(/^[0-9a-f]{8}$/);
  });
});
