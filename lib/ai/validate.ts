/**
 * Drafting constraints, enforced programmatically.
 *
 * Rebuilt for Phase 8 section 6A, narrower than the version Phase 7 retired.
 * These rules are stated in the prompt *and* checked here. A prompt
 * instruction is a strong suggestion; this is the part that actually holds.
 *
 * Retry exactly once, never in a loop (6A.3): a validator that turns out to be
 * too strict must degrade into showing Eddie something flagged, not into
 * burning tokens until a draft happens to pass. Every rejection reason is
 * returned so the rules can be tuned from real failures rather than paid for
 * in retries.
 *
 * What changed from the retired version, and why:
 *
 *   - **No first-contact opener rule.** The old validator required a first
 *     message to open "Hi X, this is Eddie Canvasser from E Mortgage Capital".
 *     That rule cannot apply here: drafting is scoped to leads already
 *     quoted, so there is always prior outbound. Only the inverse survives,
 *     and it is now unconditional — a draft in this window that reintroduces
 *     Eddie is wrong by definition.
 *   - **No voice profile.** `allowEmoji` and `neverUses` came from the
 *     structured profile that 6A.2 leaves buried. Emoji are simply banned;
 *     style comes from passing real outbound messages as exemplars instead.
 */

export type Channel = "sms" | "email";

/** SMS hard cap. Longer than this and it fragments across messages. */
export const SMS_MAX_CHARS = 320;
export const SMS_MAX_SENTENCES = 3;
export const EMAIL_MAX_WORDS = 120;

/**
 * Phrases that mark a message as filler. Kept intact from the retired
 * validator per 6A.2 — every one is a way of saying "I have nothing specific
 * to tell you" while sounding busy. Matched case-insensitively.
 */
export const BANNED_PHRASES = [
  "i wanted to reach out",
  "just checking in",
  "just following up",
  "circling back",
  "touching base",
  "hope this finds you well",
  "i'd love to",
  "i would love to",
  "excited to",
  "amazing",
  "dream home",
  "let's get you",
  "lets get you",
  "no pressure",
  "quick question!",
];

export interface DraftContext {
  channel: Channel;
  brokerName: string;
  brokerCompany: string;
  /**
   * Everything we actually know: mortgage fields plus the message history.
   * Any figure in the draft must be traceable to this.
   */
  groundingCorpus: string;
  /**
   * The loan file plus what the *lead* said, without the broker's own
   * outbound messages. Defaults to groundingCorpus when absent.
   *
   * Separate because the two rules want different things. Grounding asks
   * "could this figure have come from anywhere we know", so the broader
   * corpus is right. Specificity asks "is this about them", and Eddie's own
   * messages make that trivially true — "sent", "rate" and "quote" appear in
   * every thread he has, so any draft sharing a word with his own past
   * writing passed a check that was supposed to be about theirs.
   */
  specificityCorpus?: string;
}

export interface Violation {
  rule: string;
  detail: string;
}

export function validateDraft(text: string, ctx: DraftContext): Violation[] {
  const violations: Violation[] = [];
  const body = text.trim();

  if (!body) {
    return [{ rule: "empty", detail: "Draft is empty" }];
  }

  checkNoReintroduction(body, ctx, violations);
  checkLength(body, ctx, violations);
  checkBannedPhrases(body, violations);
  checkPunctuation(body, violations);
  checkEmoji(body, violations);
  checkFactualGrounding(body, ctx, violations);
  checkSpecificity(body, ctx, violations);

  return violations;
}

/**
 * 6A.3, first rule: no reintroduction.
 *
 * Unconditional here, unlike the retired version's context-dependent check.
 * The scope is leads Eddie quoted hours ago — he has already spoken to every
 * one of them — so a draft opening "this is Eddie Canvasser from E Mortgage
 * Capital" is wrong by definition in this window.
 */
function checkNoReintroduction(body: string, ctx: DraftContext, out: Violation[]): void {
  const haystack = normalizeForCompare(body);
  const name = normalizeForCompare(ctx.brokerName);
  const company = normalizeForCompare(ctx.brokerCompany);

  // "this is Eddie" / "this is Eddie Canvasser from E Mortgage Capital" —
  // matched on the introduction frame rather than the bare name, so a draft
  // that says "I'll get Eddie to send that over" is not caught.
  const frames = [
    `this is ${name}`,
    `it's ${name}`,
    `its ${name}`,
    `${name} here`,
    `my name is ${name}`,
    `i'm ${name}`,
    `im ${name}`,
  ];

  for (const frame of frames) {
    if (haystack.includes(frame)) {
      out.push({
        rule: "reintroduction",
        detail: `Reintroduces the broker ("${frame}") to a lead he has already spoken to`,
      });
      return;
    }
  }

  if (haystack.includes(`from ${company}`)) {
    out.push({
      rule: "reintroduction",
      detail: `Names the company as an introduction ("from ${ctx.brokerCompany}")`,
    });
  }
}

function checkLength(body: string, ctx: DraftContext, out: Violation[]): void {
  if (ctx.channel === "sms") {
    if (body.length > SMS_MAX_CHARS) {
      out.push({
        rule: "sms_too_long",
        detail: `${body.length} characters; hard cap is ${SMS_MAX_CHARS}`,
      });
    }
    const sentences = countSentences(body);
    if (sentences > SMS_MAX_SENTENCES) {
      out.push({
        rule: "sms_too_many_sentences",
        detail: `${sentences} sentences; cap is ${SMS_MAX_SENTENCES}`,
      });
    }
    return;
  }

  const words = body.split(/\s+/).filter(Boolean).length;
  if (words > EMAIL_MAX_WORDS) {
    out.push({
      rule: "email_too_long",
      detail: `${words} words; hard cap is ${EMAIL_MAX_WORDS}`,
    });
  }
}

function checkBannedPhrases(body: string, out: Violation[]): void {
  const haystack = normalizeForCompare(body);

  for (const phrase of BANNED_PHRASES) {
    if (haystack.includes(normalizeForCompare(phrase))) {
      out.push({ rule: "banned_phrase", detail: `Contains "${phrase}"` });
    }
  }

  /*
   * "not just X, but Y" and friends — rhetorically balanced constructions
   * that read as copywriting rather than a person typing.
   *
   * Decimals are masked first. The clause is bounded by sentence punctuation
   * so the two halves have to belong to the same sentence, and without this
   * the "." in "6.5%" ends the clause early — which is exactly the kind of
   * text a mortgage draft is full of, so the rule silently stopped firing on
   * the drafts it most needed to catch.
   */
  if (/\bnot (just|only)\b[^.!?]*\bbut\b/i.test(maskDecimals(body))) {
    out.push({
      rule: "rhetorical_balance",
      detail: 'Uses a "not just X, but Y" construction',
    });
  }
}

function checkPunctuation(body: string, out: Violation[]): void {
  const exclamations = (body.match(/!/g) ?? []).length;
  if (exclamations > 1) {
    out.push({
      rule: "too_many_exclamations",
      detail: `${exclamations} exclamation points; at most one is allowed`,
    });
  }

  // Em dashes are the clearest tell of generated prose in short messages.
  const emDashes = (body.match(/—/g) ?? []).length;
  if (emDashes > 1) {
    out.push({
      rule: "em_dash_heavy",
      detail: `${emDashes} em dashes; at most one is allowed`,
    });
  }
}

function checkEmoji(body: string, out: Violation[]): void {
  const emoji = body.match(/\p{Extended_Pictographic}/gu);
  if (emoji && emoji.length > 0) {
    out.push({
      rule: "emoji",
      detail: `Contains ${emoji.join(" ")}; drafts carry no emoji`,
    });
  }
}

/**
 * Rejects figures that do not appear in what we actually know.
 *
 * 6A.3 calls this the highest-stakes rule here, and it is: Eddie quoted these
 * people. A draft that misstates the quote is worse than no draft, and he
 * would have to catch it by eye every single time.
 *
 * Deliberately narrow to avoid false positives, which cost a retry: it checks
 * percentages, currency amounts, loan terms, and long bare numbers. Small
 * integers ("2 options", "give me 3 days") are ignored.
 */
export function extractFactualClaims(text: string): string[] {
  const claims: string[] = [];

  // Percentages: 6.5%, 6.5 %, 6.5 percent
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(?:%|percent)/gi)) {
    claims.push(m[1]);
  }
  // Currency: $450,000 / $2,850 / $1.2M
  for (const m of text.matchAll(/\$\s*([\d,]+(?:\.\d+)?)\s*([kmKM])?/g)) {
    claims.push(m[1].replace(/,/g, "") + (m[2] ?? ""));
  }
  // Loan terms: 30-year, 15 year
  for (const m of text.matchAll(/(\d+)[\s-]*year\b/gi)) {
    claims.push(m[1]);
  }
  // Long bare numbers (>= 4 digits). A credit score written as 720 is three
  // digits and skipped deliberately.
  for (const m of text.matchAll(/\b(\d{4,})\b/g)) {
    claims.push(m[1]);
  }

  return Array.from(new Set(claims));
}

function checkFactualGrounding(
  body: string,
  ctx: DraftContext,
  out: Violation[]
): void {
  const claims = extractFactualClaims(body);
  if (claims.length === 0) return;

  const known = knownNumbers(ctx.groundingCorpus);

  for (const claim of claims) {
    if (!known.has(claim.toLowerCase())) {
      out.push({
        rule: "ungrounded_figure",
        detail: `States "${claim}", which does not appear in the loan file or the conversation`,
      });
    }
  }
}

/**
 * Every number that appears in what we know, as discrete tokens.
 *
 * Compared as a set rather than by substring. Substring matching silently
 * *accepts* invented figures: "5000" is a substring of a known "450000", so a
 * drafted payment of $5,000 would have passed against a loan amount of
 * $450,000. Exact token matching is the whole point of this rule.
 */
export function knownNumbers(corpus: string): Set<string> {
  const stripped = corpus.replace(/,/g, "");
  const tokens = stripped.match(/\d+(?:\.\d+)?/g) ?? [];
  const set = new Set<string>();
  for (const t of tokens) {
    set.add(t.toLowerCase());
    // "450000.00" in a file should also ground a draft that writes "450000".
    if (t.includes(".")) set.add(t.replace(/\.0+$/, "").toLowerCase());
  }
  return set;
}

/**
 * 6A.3, last rule: the draft has to be recognisably about this lead.
 *
 * The weakest of the checks and deliberately so. "Reference the actual
 * conversation" is not fully mechanisable, and the retry-once-then-flag policy
 * makes a lenient check the right trade: a false negative costs nothing, a
 * false positive costs one retry and then surfaces flagged anyway.
 *
 * What it asks for is one substantial word the draft shares with the loan file
 * or the thread — the lead's objection, their timeline, their question. A
 * generic nudge with a name merged in has none.
 */
function checkSpecificity(body: string, ctx: DraftContext, out: Violation[]): void {
  const corpusWords = contentWords(ctx.specificityCorpus ?? ctx.groundingCorpus);
  // Nothing known about the lead means nothing to be specific about; the
  // grounding rule already stops it inventing something.
  if (corpusWords.size === 0) return;

  const shared = [...contentWords(body)].some((w) => corpusWords.has(w));
  if (!shared) {
    out.push({
      rule: "not_specific",
      detail:
        "Shares no substantive word with the loan file or the conversation; " +
        "reads as a generic nudge rather than a message about this lead",
    });
  }
}

/**
 * Words long enough to carry meaning, minus the ones every message contains.
 * Four characters is the floor because "rate", "cash" and "term" all matter.
 */
const STOPWORDS = new Set([
  "that", "this", "with", "your", "you", "have", "will", "from", "been",
  "they", "them", "were", "what", "when", "just", "like", "want", "know",
  "back", "over", "into", "more", "than", "then", "some", "here", "make",
  "take", "give", "send", "call", "text", "email", "today", "tomorrow",
  "week", "would", "could", "should", "about", "there", "their", "thanks",
  "hello", "morning", "afternoon", "sent", "thought", "thoughts", "anything",
  "something", "let", "look", "looking", "getting", "still", "sure", "much",
  "over", "quick", "update", "wanted", "reach", "chat", "talk", "speak",
]);

function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z]{4,}/g) ?? []) {
    if (!STOPWORDS.has(raw)) out.add(raw);
  }
  return out;
}

/** Replaces the dot in a decimal so sentence-bounded rules do not stop at it. */
function maskDecimals(s: string): string {
  return s.replace(/(\d)\.(\d)/g, "$1\u0000$2");
}

function normalizeForCompare(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function countSentences(text: string): number {
  const matches = text.match(/[^.!?]+[.!?]+(\s|$)/g);
  if (!matches) return text.trim() ? 1 : 0;
  // Trailing fragment with no terminator still counts as a sentence.
  const consumed = matches.join("").length;
  const remainder = text.trim().length - consumed;
  return matches.length + (remainder > 0 ? 1 : 0);
}

/**
 * The constraint text injected into the drafting prompt.
 *
 * Stated as rules rather than preferences, and kept in the stable prefix so it
 * never varies per lead.
 */
export function buildConstraintBlock(opts: {
  brokerName: string;
  brokerCompany: string;
}): string {
  return `HARD RULES. A draft that breaks any of these is rejected before the broker sees it.

WHO YOU ARE WRITING AS
- You are drafting a message from ${opts.brokerName}, who has already spoken to this person and already sent them a quote.
- Never introduce him. No "this is ${opts.brokerName}", no "from ${opts.brokerCompany}". They know who he is.

LENGTH
- SMS: ${SMS_MAX_CHARS} characters maximum, ${SMS_MAX_SENTENCES} sentences maximum.
- Email: ${EMAIL_MAX_WORDS} words maximum.

NEVER WRITE
- More than one exclamation point in the whole message.
- More than one em dash in the whole message.
- Any emoji.
- Any of these: ${BANNED_PHRASES.map((p) => `"${p}"`).join(", ")}.
- Rhetorically balanced constructions such as "not just X, but Y".

FIGURES
- Never state a rate, payment, term, program name, or dollar amount that does not appear in the loan file or earlier in this conversation.
- If the message needs a figure you were not given, ask for it or say you will find out. Do not estimate, and do not illustrate with an example number.

BE ABOUT THIS LEAD
- Reference what they actually said: their objection, their timeline, their question. A generic nudge with a name merged in is a failure, not a safe default.`;
}
