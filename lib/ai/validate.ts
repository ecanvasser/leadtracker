/**
 * Drafting constraints, enforced programmatically.
 *
 * These are stated in the prompt *and* checked here. A prompt instruction is a
 * strong suggestion; this is the part that actually holds. A draft that
 * violates a rule is rejected and regenerated once — then surfaced anyway,
 * flagged as unvalidated.
 *
 * Retry exactly once, never in a loop: a validator that is too strict must
 * degrade into showing the broker something, not into burning tokens. Every
 * rejection reason is returned so the rules can be tuned from real data
 * rather than paid for in retries.
 */

export type Channel = "sms" | "email";

/** SMS hard cap. Longer than this and it fragments across messages. */
export const SMS_MAX_CHARS = 320;
export const SMS_MAX_SENTENCES = 3;
export const EMAIL_MAX_WORDS = 120;

/**
 * Phrases that mark a message as filler.
 *
 * Every one of these is a way of saying "I have nothing specific to tell you"
 * while sounding busy. They are matched case-insensitively on word boundaries.
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
  /** Prospect's first name, for the opener rule. */
  firstName: string;
  brokerName: string;
  brokerCompany: string;
  /** True when this is the first outbound message in the thread. */
  isFirstOutbound: boolean;
  /** From the voice profile. Emoji are banned unless this is true. */
  allowEmoji: boolean;
  /** Extra phrases the broker has said he never writes. */
  neverUses?: string[];
  /**
   * Everything we actually know: mortgage fields plus the message history.
   * Any figure in the draft must be traceable to this.
   */
  groundingCorpus: string;
}

export interface Violation {
  rule: string;
  detail: string;
}

/** The opener a first message must use. */
export function expectedOpener(ctx: DraftContext): string {
  return `Hi ${ctx.firstName}, this is ${ctx.brokerName} from ${ctx.brokerCompany}`;
}

export function validateDraft(text: string, ctx: DraftContext): Violation[] {
  const violations: Violation[] = [];
  const body = text.trim();

  if (!body) {
    return [{ rule: "empty", detail: "Draft is empty" }];
  }

  checkOpener(body, ctx, violations);
  checkLength(body, ctx, violations);
  checkBannedPhrases(body, ctx, violations);
  checkPunctuation(body, violations);
  checkEmoji(body, ctx, violations);
  checkFactualGrounding(body, ctx, violations);

  return violations;
}

function checkOpener(body: string, ctx: DraftContext, out: Violation[]): void {
  const opener = expectedOpener(ctx);
  const normalizedBody = normalizeForCompare(body);
  const normalizedOpener = normalizeForCompare(opener);

  if (ctx.isFirstOutbound) {
    if (!normalizedBody.startsWith(normalizedOpener)) {
      out.push({
        rule: "opener_missing",
        detail: `First message in a thread must open with "${opener}"`,
      });
    }
    return;
  }

  // Already introduced. Reintroducing reads as a mail merge.
  const introFragment = normalizeForCompare(
    `this is ${ctx.brokerName} from ${ctx.brokerCompany}`
  );
  if (normalizedBody.includes(introFragment)) {
    out.push({
      rule: "opener_repeated",
      detail:
        "Reintroduces the broker in a thread where he has already introduced himself",
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

function checkBannedPhrases(body: string, ctx: DraftContext, out: Violation[]): void {
  const haystack = normalizeForCompare(body);

  for (const phrase of BANNED_PHRASES) {
    if (haystack.includes(normalizeForCompare(phrase))) {
      out.push({ rule: "banned_phrase", detail: `Contains "${phrase}"` });
    }
  }

  for (const phrase of ctx.neverUses ?? []) {
    const needle = normalizeForCompare(phrase);
    if (needle && haystack.includes(needle)) {
      out.push({
        rule: "voice_profile_banned",
        detail: `Contains "${phrase}", which the voice profile says he never writes`,
      });
    }
  }

  // "not just X, but Y" and friends — rhetorically balanced constructions that
  // read as copywriting rather than a person typing.
  if (/\bnot (just|only)\b[^.!?]*\bbut\b/i.test(body)) {
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

function checkEmoji(body: string, ctx: DraftContext, out: Violation[]): void {
  if (ctx.allowEmoji) return;
  const emoji = body.match(/\p{Extended_Pictographic}/gu);
  if (emoji && emoji.length > 0) {
    out.push({
      rule: "emoji",
      detail: `Contains ${emoji.join(" ")}; the voice profile says he does not use emoji`,
    });
  }
}

/**
 * Rejects figures that do not appear in what we actually know.
 *
 * This is the constraint that matters most. A drafted message quoting an
 * invented rate is not a tone problem — it is a message that must never be
 * sent, and the broker would have to catch it by eye every time.
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
  // Long bare numbers (>= 4 digits), e.g. an unmarked 450000 or a credit score
  // written as 720 is 3 digits and skipped deliberately.
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
  allowEmoji: boolean;
}): string {
  return `HARD RULES. A draft that breaks any of these is rejected before the broker sees it.

OPENER
- The first outbound message in a thread must begin exactly: "Hi {first_name}, this is ${opts.brokerName} from ${opts.brokerCompany}".
- If he has already introduced himself in this thread, do not reintroduce him. No "this is ${opts.brokerName} from ${opts.brokerCompany}" in a reply.

LENGTH
- SMS: ${SMS_MAX_CHARS} characters maximum, ${SMS_MAX_SENTENCES} sentences maximum.
- Email: ${EMAIL_MAX_WORDS} words maximum.

NEVER WRITE
- More than one exclamation point in the whole message.
- More than one em dash in the whole message.
- Any of these: ${BANNED_PHRASES.map((p) => `"${p}"`).join(", ")}.
- Rhetorically balanced constructions such as "not just X, but Y".
${opts.allowEmoji ? "- Emoji are acceptable, used sparingly." : "- Any emoji."}

FIGURES
- Never state a rate, payment, term, program name, or dollar amount that does not appear in the loan file or earlier in this conversation.
- If the message needs a figure you were not given, ask for it or say you will find out. Do not estimate, and do not illustrate with an example number.`;
}
