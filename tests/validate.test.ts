import { describe, it, expect } from "vitest";
import {
  validateDraft,
  extractFactualClaims,
  buildConstraintBlock,
  expectedOpener,
  SMS_MAX_CHARS,
  EMAIL_MAX_WORDS,
  type DraftContext,
} from "@/lib/ai/validate";

const CORPUS = [
  "loan_amount: 450000",
  "credit_score: 720",
  "property_value: 560000",
  "loan_purpose: refinance",
  "[2026-08-18] PROSPECT: what would my payment look like on a 30 year?",
  "[2026-08-18] BROKER: I'll pull numbers and get back to you.",
].join("\n");

function ctx(overrides: Partial<DraftContext> = {}): DraftContext {
  return {
    channel: "sms",
    firstName: "Dana",
    brokerName: "Eddie Canvasser",
    brokerCompany: "E Mortgage Capital",
    isFirstOutbound: false,
    allowEmoji: false,
    neverUses: [],
    groundingCorpus: CORPUS,
    ...overrides,
  };
}

function rules(text: string, c: DraftContext = ctx()): string[] {
  return validateDraft(text, c).map((v) => v.rule);
}

describe("a clean draft passes", () => {
  it("accepts a short, grounded reply", () => {
    expect(rules("Got your note. I'll have the refinance numbers Thursday.")).toEqual([]);
  });

  it("accepts a correct first message", () => {
    const text =
      "Hi Dana, this is Eddie Canvasser from E Mortgage Capital. You asked about a 30 year — I'll have numbers Thursday.";
    expect(rules(text, ctx({ isFirstOutbound: true }))).toEqual([]);
  });

  it("accepts a single exclamation point", () => {
    expect(rules("Congrats on the offer! I'll get started.")).toEqual([]);
  });
});

describe("opener rule", () => {
  it("rejects a first message that does not introduce him", () => {
    expect(rules("Hey Dana, saw your application come through.", ctx({ isFirstOutbound: true })))
      .toContain("opener_missing");
  });

  it("rejects a first message that introduces him differently", () => {
    const text = "Hi Dana, Eddie here from E Mortgage Capital.";
    expect(rules(text, ctx({ isFirstOutbound: true }))).toContain("opener_missing");
  });

  it("rejects reintroducing himself mid-thread", () => {
    const text = "Hi Dana, this is Eddie Canvasser from E Mortgage Capital. Following up.";
    expect(rules(text, ctx({ isFirstOutbound: false }))).toContain("opener_repeated");
  });

  it("uses the configured broker name and company", () => {
    const c = ctx({
      isFirstOutbound: true,
      brokerName: "Sam Rivera",
      brokerCompany: "Northgate Lending",
    });
    expect(expectedOpener(c)).toBe("Hi Dana, this is Sam Rivera from Northgate Lending");
    expect(rules("Hi Dana, this is Sam Rivera from Northgate Lending. Quick note.", c))
      .toEqual([]);
  });

  it("tolerates smart quotes and spacing differences in the opener", () => {
    const text = "Hi Dana,  this is Eddie Canvasser from E Mortgage Capital. Numbers Thursday.";
    expect(rules(text, ctx({ isFirstOutbound: true }))).toEqual([]);
  });
});

describe("length rules", () => {
  it("rejects a 600-character SMS", () => {
    const long = "I can help with that. ".repeat(30);
    expect(long.length).toBeGreaterThan(SMS_MAX_CHARS);
    expect(rules(long)).toContain("sms_too_long");
  });

  it("rejects an SMS with too many sentences", () => {
    const text = "Got it. I'll check. Then I'll call. Then we can decide.";
    expect(rules(text)).toContain("sms_too_many_sentences");
  });

  it("rejects an over-long email", () => {
    const words = Array.from({ length: EMAIL_MAX_WORDS + 20 }, () => "word").join(" ");
    expect(rules(words, ctx({ channel: "email" }))).toContain("email_too_long");
  });

  it("allows an email that would be too long as an SMS", () => {
    const text = Array.from({ length: 90 }, () => "word").join(" ");
    expect(rules(text, ctx({ channel: "email" }))).not.toContain("email_too_long");
  });
});

describe("banned phrases", () => {
  const cases = [
    "just checking in",
    "I wanted to reach out",
    "circling back",
    "touching base",
    "hope this finds you well",
    "just following up",
    "no pressure",
    "dream home",
  ];

  for (const phrase of cases) {
    it(`rejects "${phrase}"`, () => {
      expect(rules(`Hey Dana, ${phrase} on your file.`)).toContain("banned_phrase");
    });
  }

  it("matches case-insensitively", () => {
    expect(rules("JUST CHECKING IN on your file.")).toContain("banned_phrase");
  });

  it("rejects a rhetorically balanced construction", () => {
    const text = "This is not just a rate change, but a chance to restructure.";
    expect(rules(text)).toContain("rhetorical_balance");
  });

  it("rejects phrases the voice profile bans", () => {
    const c = ctx({ neverUses: ["let me know if you have any questions"] });
    expect(rules("Numbers attached. Let me know if you have any questions.", c))
      .toContain("voice_profile_banned");
  });
});

describe("punctuation", () => {
  it("rejects more than one exclamation point", () => {
    expect(rules("Great news! Your file is clear!")).toContain("too_many_exclamations");
  });

  it("rejects em-dash-heavy prose", () => {
    const text = "Your rate — the one we discussed — is locked.";
    expect(rules(text)).toContain("em_dash_heavy");
  });

  it("allows a single em dash", () => {
    expect(rules("Your rate is locked — good through Friday.")).not.toContain("em_dash_heavy");
  });
});

describe("emoji", () => {
  it("rejects emoji by default", () => {
    expect(rules("Your file is approved 🎉")).toContain("emoji");
  });

  it("allows emoji when the voice profile says he uses them", () => {
    expect(rules("Your file is approved 🎉", ctx({ allowEmoji: true }))).not.toContain("emoji");
  });
});

// The constraint that matters most: a drafted message quoting an invented rate
// must never reach the send button.
describe("factual grounding", () => {
  it("rejects an invented interest rate", () => {
    expect(rules("Good news, I can get you 5.25% on this.")).toContain("ungrounded_figure");
  });

  it("rejects an invented monthly payment", () => {
    expect(rules("That puts you around $2,340 a month.")).toContain("ungrounded_figure");
  });

  it("rejects an invented loan term", () => {
    expect(rules("The 40 year option might work better.")).toContain("ungrounded_figure");
  });

  it("accepts a figure that appears in the loan file", () => {
    expect(rules("Still working with the $450,000 figure?")).not.toContain("ungrounded_figure");
  });

  it("accepts a figure the prospect themselves raised", () => {
    // "30 year" appears in the pulled conversation history.
    expect(rules("On the 30 year, I'll have numbers Thursday.")).not.toContain("ungrounded_figure");
  });

  it("matches across comma formatting", () => {
    // Corpus stores 450000; the draft writes $450,000.
    expect(rules("Confirming the $450,000 amount.")).not.toContain("ungrounded_figure");
  });

  it("ignores small integers so ordinary phrasing is not flagged", () => {
    expect(rules("Give me 2 days and I'll have it.")).not.toContain("ungrounded_figure");
    expect(rules("I have 3 options for you.")).not.toContain("ungrounded_figure");
  });

  it("flags each ungrounded figure separately so the reason is tunable", () => {
    const violations = validateDraft("I can do 5.25% or $1,899 a month.", ctx());
    const grounding = violations.filter((v) => v.rule === "ungrounded_figure");
    expect(grounding.length).toBe(2);
  });
});

describe("extractFactualClaims", () => {
  it("picks up percentages, currency and terms", () => {
    const claims = extractFactualClaims("6.5% on a 30-year at $450,000");
    expect(claims).toContain("6.5");
    expect(claims).toContain("30");
    expect(claims).toContain("450000");
  });

  it("handles 'percent' spelled out", () => {
    expect(extractFactualClaims("about 6.25 percent")).toContain("6.25");
  });

  it("returns nothing for text with no figures", () => {
    expect(extractFactualClaims("I'll call you tomorrow morning.")).toEqual([]);
  });
});

describe("multiple violations", () => {
  it("reports every rule broken, not just the first", () => {
    const text =
      "Hi Dana, just checking in! Excited to get you into your dream home at 4.75%! 🎉";
    const found = rules(text);
    expect(found).toContain("banned_phrase");
    expect(found).toContain("too_many_exclamations");
    expect(found).toContain("emoji");
    expect(found).toContain("ungrounded_figure");
    expect(found.length).toBeGreaterThan(4);
  });

  it("rejects an empty draft outright", () => {
    expect(rules("   ")).toEqual(["empty"]);
  });
});

describe("buildConstraintBlock", () => {
  it("states the configured broker identity in the opener rule", () => {
    const block = buildConstraintBlock({
      brokerName: "Eddie Canvasser",
      brokerCompany: "E Mortgage Capital",
      allowEmoji: false,
    });
    expect(block).toContain("Eddie Canvasser from E Mortgage Capital");
    expect(block).toContain("Any emoji");
  });

  it("permits emoji in the prompt when the profile allows them", () => {
    const block = buildConstraintBlock({
      brokerName: "E",
      brokerCompany: "C",
      allowEmoji: true,
    });
    expect(block).toContain("Emoji are acceptable");
  });

  it("lists every banned phrase the validator enforces", () => {
    const block = buildConstraintBlock({
      brokerName: "E",
      brokerCompany: "C",
      allowEmoji: false,
    });
    // Prompt and validator must not drift apart.
    expect(block).toContain("just checking in");
    expect(block).toContain("circling back");
  });
});

// Regression: substring matching silently accepted invented figures, because
// "5000" is a substring of a known "450000". Grounding compares whole numbers.
describe("grounding uses whole numbers, not substrings", () => {
  it("rejects a payment that merely appears inside a known larger number", () => {
    // Corpus knows loan_amount 450000. A $5,000 payment is NOT grounded by it.
    expect(rules("Your payment would be about $5,000.")).toContain("ungrounded_figure");
  });

  it("rejects a rate that appears inside a known number", () => {
    // "6000" contains "600"; a 600 credit score claim must not be grounded by it.
    const c = ctx({ groundingCorpus: "loan_amount: 6000" });
    expect(rules("Your score is 6000 so we are fine.", c)).not.toContain("ungrounded_figure");
    expect(rules("I can do $60,000 on this.", c)).toContain("ungrounded_figure");
  });

  it("still grounds an exact match written with separators", () => {
    expect(rules("Confirming $450,000.")).not.toContain("ungrounded_figure");
  });

  it("grounds a whole number against a file value with trailing decimals", () => {
    const c = ctx({ groundingCorpus: "loan_amount: 450000.00" });
    expect(rules("Confirming $450,000.", c)).not.toContain("ungrounded_figure");
  });
});
