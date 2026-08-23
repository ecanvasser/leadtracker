import { describe, it, expect } from "vitest";
import {
  BANNED_PHRASES,
  EMAIL_MAX_WORDS,
  SMS_MAX_CHARS,
  extractFactualClaims,
  knownNumbers,
  validateDraft,
  type DraftContext,
} from "@/lib/ai/validate";
import { isInDraftScope, styleExemplars } from "@/lib/ai/draft-one";
import type { BonzoCommunication } from "@/lib/bonzo/client";

/**
 * The loan file and thread every draft below is checked against. Section 6A.3
 * is explicit that these rules are enforced programmatically rather than
 * suggested in a prompt, so this file is where "enforced" is demonstrated.
 */
const CORPUS = [
  "loan_amount: 450,000",
  "property_value: 610,000",
  "credit_score: 720",
  "loan_program: 30 year fixed",
  "Sent you the numbers: 6.5% on a 30 year, payment lands at 2,845 a month.",
  "That rate is higher than what my credit union quoted me last week.",
].join("\n");

/** What the lead said, plus the loan file — never Eddie's own messages. */
const SPECIFICITY_CORPUS = [
  "loan_amount: 450,000",
  "property_value: 610,000",
  "credit_score: 720",
  "loan_program: 30 year fixed",
  "That rate is higher than what my credit union quoted me last week.",
].join("\n");

function ctx(over: Partial<DraftContext> = {}): DraftContext {
  return {
    channel: "sms",
    brokerName: "Eddie Canvasser",
    brokerCompany: "E Mortgage Capital",
    groundingCorpus: CORPUS,
    specificityCorpus: SPECIFICITY_CORPUS,
    ...over,
  };
}

/** A draft that should pass everything, used as the control. */
const GOOD =
  "That credit union rate is worth seeing in writing before you decide. Send me their quote and I'll show you where the 6.5% actually lands against it.";

function rules(text: string, c: DraftContext = ctx()): string[] {
  return validateDraft(text, c).map((v) => v.rule);
}

describe("the control draft passes", () => {
  it("has no violations", () => {
    expect(validateDraft(GOOD, ctx())).toEqual([]);
  });
});

/*
 * Section 8, "Drafting constraints": feed known-bad drafts and assert each is
 * rejected.
 */
describe("known-bad drafts are rejected", () => {
  it("two exclamation points", () => {
    expect(
      rules("Great news on that 6.5%! Send me the credit union quote today!")
    ).toContain("too_many_exclamations");
  });

  it("one exclamation point is fine", () => {
    expect(rules(`${GOOD} Nice!`)).not.toContain("too_many_exclamations");
  });

  it("just checking in", () => {
    expect(
      rules("Just checking in on that 6.5% quote — any thoughts?")
    ).toContain("banned_phrase");
  });

  it.each(BANNED_PHRASES)("the banned phrase %s", (phrase) => {
    expect(rules(`${phrase} about the 6.5% credit union quote.`)).toContain(
      "banned_phrase"
    );
  });

  it("400 characters of SMS", () => {
    const long = `About that 6.5% rate and the credit union quote. ${"x".repeat(400)}`;
    const found = rules(long);
    expect(found).toContain("sms_too_long");
    expect(long.length).toBeGreaterThan(SMS_MAX_CHARS);
  });

  it("an email past the word cap", () => {
    const words = ["rate", ...Array(EMAIL_MAX_WORDS + 20).fill("word")].join(" ");
    expect(rules(words, ctx({ channel: "email" }))).toContain("email_too_long");
  });

  /*
   * The highest-stakes rule in the feature. Eddie quoted these people; a draft
   * that misstates the quote is worse than no draft.
   */
  it("a rate that appears nowhere in the fixture", () => {
    expect(
      rules("I can get you to 5.25% on that credit union comparison.")
    ).toContain("ungrounded_figure");
  });

  it("an invented payment", () => {
    expect(
      rules("Your new payment on that rate would be about $1,900 a month.")
    ).toContain("ungrounded_figure");
  });

  it("accepts figures that are actually in the loan file", () => {
    expect(
      rules("The 6.5% on that 30 year puts you at 2,845 — send me their quote.")
    ).not.toContain("ungrounded_figure");
  });

  /*
   * Substring matching would silently accept this: "5000" is inside the known
   * "450000". Exact token comparison is the entire point of knownNumbers.
   */
  it("does not let a substring of a known number ground an invented one", () => {
    expect(rules("That works out to $45,00 on the rate.")).toContain(
      "ungrounded_figure"
    );
    const known = knownNumbers("loan_amount: 450000");
    expect(known.has("450000")).toBe(true);
    expect(known.has("45000")).toBe(false);
    expect(known.has("5000")).toBe(false);
  });

  it("emoji", () => {
    expect(rules(`${GOOD} 👍`)).toContain("emoji");
  });

  it("a not-just-but construction", () => {
    expect(
      rules("Not just the 6.5% rate, but the credit union comparison too.")
    ).toContain("rhetorical_balance");
  });

  it("an empty draft", () => {
    expect(rules("   ")).toContain("empty");
  });

  it("a generic nudge with a name merged in", () => {
    expect(rules("Hi there, any thoughts on what I sent over?")).toContain(
      "not_specific"
    );
  });
});

/*
 * Section 8, "No reintroduction": a draft for a lead with prior outbound
 * history must not open with the broker's name and company.
 *
 * Unconditional here, unlike the retired validator's context-dependent
 * version — drafting is scoped to leads already quoted, so there is always
 * prior outbound and reintroducing is always wrong.
 */
describe("no reintroduction", () => {
  it.each([
    "Hi Dana, this is Eddie Canvasser from E Mortgage Capital. About that 6.5% rate.",
    "Dana — it's Eddie Canvasser again about the 6.5% credit union quote.",
    "Eddie Canvasser here. That 6.5% rate still stands against the credit union.",
    "My name is Eddie Canvasser and I sent you the 6.5% rate last week.",
  ])("rejects %s", (draft) => {
    expect(rules(draft)).toContain("reintroduction");
  });

  it("rejects naming the company as an introduction", () => {
    expect(
      rules("Reaching out from E Mortgage Capital about the 6.5% rate.")
    ).toContain("reintroduction");
  });

  it("does not trip on the broker's name used naturally", () => {
    expect(
      rules("I'll have the 6.5% breakdown against the credit union over to you today.")
    ).not.toContain("reintroduction");
  });
});

describe("extractFactualClaims", () => {
  it("catches percentages, currency, terms and long bare numbers", () => {
    const claims = extractFactualClaims(
      "6.5% on a 30 year at $2,845, file 450000"
    );
    expect(claims).toContain("6.5");
    expect(claims).toContain("30");
    expect(claims).toContain("2845");
    expect(claims).toContain("450000");
  });

  it("ignores small integers that are not claims about money", () => {
    expect(extractFactualClaims("I have 2 options and need 3 days")).toEqual([]);
  });
});

/*
 * Section 8, "Scope": no draft is generated for a lead outside
 * quoted_follow_up, or outside the park window.
 */
describe("draft scope", () => {
  const NOW = new Date("2026-08-23T18:00:00Z");
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

  it("allows a lead quoted three hours ago", () => {
    expect(
      isInDraftScope({
        stage: "quoted_follow_up",
        stageChangedAt: hoursAgo(3),
        windowDays: 2,
        now: NOW,
      }).inScope
    ).toBe(true);
  });

  it.each(["hot_lead", "needs_quote", "app_in", "submission", "processing", "adverse", "funded"] as const)(
    "refuses a lead in %s",
    (stage) => {
      const out = isInDraftScope({
        stage,
        stageChangedAt: hoursAgo(3),
        windowDays: 2,
        now: NOW,
      });
      expect(out.inScope).toBe(false);
      expect(out.reason).toContain(stage);
    }
  );

  it("refuses a lead past the handoff window", () => {
    const out = isInDraftScope({
      stage: "quoted_follow_up",
      stageChangedAt: hoursAgo(49),
      windowDays: 2,
      now: NOW,
    });
    expect(out.inScope).toBe(false);
    expect(out.reason).toContain("window");
  });

  it("refuses a lead with no recorded pitch time", () => {
    // The safe direction: the alternative is drafting to someone on the
    // strength of not knowing when they were quoted.
    const out = isInDraftScope({
      stage: "quoted_follow_up",
      stageChangedAt: null,
      windowDays: 2,
      now: NOW,
    });
    expect(out.inScope).toBe(false);
  });

  it("sits exactly on the boundary without falling off it", () => {
    expect(
      isInDraftScope({
        stage: "quoted_follow_up",
        stageChangedAt: hoursAgo(48),
        windowDays: 2,
        now: NOW,
      }).inScope
    ).toBe(true);
  });
});

describe("style exemplars", () => {
  const comm = (i: number, direction: string, content: string): BonzoCommunication => ({
    id: i,
    content,
    direction,
    type: "sms",
    subject: null,
    status: null,
    created_at: new Date(2026, 7, i).toISOString(),
    user_name: null,
    source: null,
  });

  it("takes only the broker's own messages, newest last", () => {
    const out = styleExemplars([
      comm(1, "outgoing", "first"),
      comm(2, "incoming", "theirs"),
      comm(3, "outgoing", "second"),
    ]);
    expect(out).toEqual(["first", "second"]);
  });

  it("caps at ten and keeps the most recent", () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      comm(i + 1, "outgoing", `msg${i + 1}`)
    );
    const out = styleExemplars(many);
    expect(out).toHaveLength(10);
    expect(out[out.length - 1]).toBe("msg15");
    expect(out[0]).toBe("msg6");
  });

  it("skips empty messages", () => {
    expect(styleExemplars([comm(1, "outgoing", "   "), comm(2, "outgoing", "real")])).toEqual([
      "real",
    ]);
  });
});
