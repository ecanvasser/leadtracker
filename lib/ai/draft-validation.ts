/**
 * Applying the 1.3 constraints to generated drafts.
 *
 * Separated from validate.ts (which is pure rules) so the retry policy has one
 * home and can be reasoned about on its own. The policy is deliberately rigid:
 *
 *   attempt 1 -> validate -> at most ONE corrective retry -> surface regardless
 *
 * Never a loop. A validator that turns out to be too strict must degrade into
 * showing the broker something flagged, not into spending tokens until it
 * happens to pass. Rejection reasons are recorded either way so the rules can
 * be tuned from real failures.
 */

import {
  validateDraft,
  type DraftContext,
  type Violation,
} from "@/lib/ai/validate";
import { getMortgageFields, isOutbound } from "@/lib/bonzo/client";

export interface DraftValidationOutcome {
  violations: Violation[];
  /** False when a draft is being shown despite failing validation twice. */
  validated: boolean;
  attempts: number;
}

/**
 * Everything a figure in a draft may be grounded against: the loan file plus
 * the actual conversation. Built once per lead and reused across attempts.
 */
export function buildGroundingCorpus(
  prospect: Record<string, unknown> | null | undefined,
  communications: { content: string | null }[]
): string {
  const parts: string[] = [];

  const mf = getMortgageFields(prospect);
  if (mf) {
    for (const [k, v] of Object.entries(mf)) {
      if (v !== null && v !== undefined && v !== "") parts.push(`${k}: ${v}`);
    }
  }

  for (const c of communications) {
    const content = (c.content ?? "").trim();
    if (content) parts.push(content);
  }

  return parts.join("\n");
}

/**
 * Whether the broker has already introduced himself in this thread.
 *
 * Drives the opener rule. Checked against real history rather than assumed
 * from lead age: a day-old lead he already replied to has been introduced,
 * and a month-old lead he never answered has not.
 */
export function hasIntroducedSelf(
  communications: { content: string | null; direction: string }[],
  brokerName: string,
  brokerCompany: string
): boolean {
  const needleName = brokerName.toLowerCase();
  const needleCompany = brokerCompany.toLowerCase();

  return communications.some((c) => {
    if (!isOutbound(c.direction)) return false;
    const text = (c.content ?? "").toLowerCase();
    return text.includes(needleName) || text.includes(needleCompany);
  });
}

/**
 * Renders violations as a correction instruction for the retry.
 *
 * Names the specific rule broken rather than restating the whole rulebook —
 * the rulebook is already in the system prompt, and repeating it wholesale
 * tends to produce a draft that over-corrects into blandness.
 */
export function buildRetryInstruction(
  failures: { index: number; violations: Violation[] }[]
): string {
  const lines = failures.map(({ index, violations }) => {
    const detail = violations.map((v) => `  - ${v.detail}`).join("\n");
    return `ACTION_INDEX ${index} was rejected:\n${detail}`;
  });

  return `Your previous drafts broke the hard rules. Rewrite only the actions listed below, fixing exactly what is named. Keep everything that was already fine — do not rewrite a message wholesale to avoid a single word, and do not become vaguer to be safe.

${lines.join("\n\n")}`;
}

/** Validates one draft body against the lead's context. */
export function checkDraft(
  body: string | null,
  context: DraftContext
): Violation[] {
  // Calls carry talking points rather than a message; the message rules do
  // not apply to them.
  if (body === null) return [];
  return validateDraft(body, context);
}
