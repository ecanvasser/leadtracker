/**
 * Building a follow-up plan for one lead.
 *
 * One model call, at deploy time, on the best context the app will ever have:
 * the full conversation, the loan file, the classifier's read, and — the part
 * that makes this different from everything Phase 7 deleted — a brief Eddie
 * typed himself about this specific person.
 *
 * The plan is never acted on directly. It is shown to him, he activates or
 * discards it, and each step later becomes an ordinary approval card.
 */

import { callModel, type ModelUsage } from "@/lib/ai/models";
import {
  getMortgageFields,
  isOutbound,
  messagesOnly,
  type BonzoCommunication,
  type BonzoProspect,
} from "@/lib/bonzo/client";
import type { LeadState } from "@/lib/insights/lead-state";
import { HYPOTHESES, type AgentPlan, type AgentStep } from "@/lib/agents/types";

export const MIN_STEPS = 3;
export const MAX_STEPS = 6;

const PLAN_SYSTEM = `You plan a sequence of follow-up touches for one mortgage lead, on behalf of a broker who has already spoken to them.

You are not writing messages. You are deciding what each touch should be ABOUT, and when it should happen. The broker writes — or approves — the actual words later, one at a time.

WHY LEADS GO QUIET

A lead who has been quoted and stopped replying is almost never stuck on a logistical step. Something is holding them back, and in this business it is one of three things:

1. Cold feet ("risk"). They are hesitating. The outcome is not clear to them and committing feels risky.
2. Money ("money"). They do not have it, or they do not want to spend it on this right now.
3. A better promise ("competing_promise"). Another lender told them something better. It may well not be true, but they believe it.

Timing ("timing") is a real fourth answer when the evidence genuinely points there — a lead waiting on a house sale, a bonus, a lease ending. "unknown" is honest when nothing in the record points anywhere, and is better than guessing.

WHAT MAKES A PLAN WORK

A plan whose steps all say "follow up" is five nudges, and nudges do not convert. A plan that moves between hypotheses tests something: if the first touch treats it as cold feet and gets nothing, the second should stop assuming that and try money instead.

So:

- EACH STEP CHANGES THE QUESTION. Never the same angle twice with different wording. If a step's angle could be swapped with another step's without anyone noticing, the plan is wrong.
- LEAD WITH THE MOST LIKELY BLOCKER FIRST. The evidence usually points somewhere. Start there, and use later steps to test the alternatives.
- EARLY TOUCHES CLOSE, LATE TOUCHES OPEN. A touch on day 1 can reasonably ask for the next step. A touch on day 12, after silence, should be trying to get them to say anything at all — a lower bar, a genuine question, an easy out.
- SPACE THEM OUT AS THEY GO. Daily contact after a week of silence reads as desperate. Gaps should widen: something like day 1, 3, 6, 10, 14 rather than 1, 2, 3, 4, 5.
- NEVER PLAN A TOUCH THAT OFFERS TO COVER A COST, waive a fee, or pay anything on the client's behalf. The broker does not do this.
- USE THE BROKER'S BRIEF. He typed it about this specific person, minutes ago, and it outranks anything you infer from the transcript. If it says the lead mentioned a spouse who is unsure, at least one step is about the spouse.

ANGLE IS ONE LINE, ADDRESSED TO THE BROKER. "She never answered on the rate lock — ask whether the cost or the commitment is the problem." Not "Hi Dana, I wanted to follow up". RATIONALE says why this step exists at this point in the sequence.

Return only the JSON object.`;

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description:
        "One line describing the strategy of the whole sequence, for the broker to read before activating it.",
    },
    steps: {
      type: "array",
      /*
       * No `minItems` and no `maxItems`.
       *
       * Structured-output schemas support neither on arrays — `minItems` only
       * as 0 or 1, `maxItems` not at all — and each is rejected with a 400
       * before the request runs. Both bounds are stated in the description and
       * enforced after the call: normalizePlan caps at MAX_STEPS and buildPlan
       * throws if fewer than MIN_STEPS survive. That was always where they
       * were really enforced; the schema copy added nothing but a failure mode.
       */
      description: `Between ${MIN_STEPS} and ${MAX_STEPS} touches, in order. Do not exceed ${MAX_STEPS}.`,
      items: {
        type: "object",
        properties: {
          step: { type: "integer", description: "1-based position in the sequence." },
          day: {
            type: "integer",
            description:
              "Days after activation this touch is due. Strictly increasing across steps, with widening gaps.",
          },
          hypothesis: { type: "string", enum: [...HYPOTHESES] },
          angle: {
            type: "string",
            description:
              "One line naming what this touch leads with, addressed to the broker. Not a message.",
          },
          rationale: {
            type: "string",
            description: "Why this step exists at this point in the sequence.",
          },
        },
        required: ["step", "day", "hypothesis", "angle", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "steps"],
  additionalProperties: false,
};

export interface BuildPlanInput {
  contactName: string;
  loanType: string;
  stage: string;
  /** Eddie's brief. Required — the whole safety argument rests on it. */
  context: string;
  goal: string;
  durationDays: number;
  prospect: BonzoProspect | null;
  communications: BonzoCommunication[];
  leadState: LeadState | null;
}

export interface BuildPlanResult {
  plan: AgentPlan;
  usage: ModelUsage;
}

/**
 * Normalises whatever the model returned into a plan that is safe to schedule.
 *
 * Exported and pure so the rules are testable without a model call. Every fix
 * here is silent and deliberate — a plan is shown to Eddie before it acts, so
 * a repaired plan gets reviewed anyway, and refusing outright over a duplicate
 * day would waste the call for no gain in safety.
 */
export function normalizePlan(raw: AgentPlan, durationDays: number): AgentPlan {
  const seen = new Set<number>();
  const steps: AgentStep[] = [];

  const sorted = [...(raw.steps ?? [])].sort((a, b) => (a.day ?? 0) - (b.day ?? 0));

  for (const s of sorted) {
    if (steps.length >= MAX_STEPS) break;

    const angle = (s.angle ?? "").trim();
    // A step with no angle is a nudge, which is the thing this design exists
    // to avoid. Dropped rather than sent to Eddie as filler.
    if (!angle) continue;

    let day = Math.round(Number(s.day));
    if (!Number.isFinite(day)) continue;
    // Day 0 would fire the instant it is activated, on top of whatever
    // conversation prompted Eddie to deploy in the first place.
    day = Math.min(Math.max(day, 1), durationDays);

    // Collisions push later rather than merge: two touches on one day breaks
    // the one-message-a-day rule and the second would be cancelled anyway.
    while (seen.has(day) && day < durationDays) day++;
    if (seen.has(day)) continue;
    seen.add(day);

    steps.push({
      step: steps.length + 1,
      day,
      hypothesis: HYPOTHESES.includes(s.hypothesis) ? s.hypothesis : "unknown",
      angle,
      rationale: (s.rationale ?? "").trim(),
    });
  }

  return {
    summary: (raw.summary ?? "").trim() || "Follow-up sequence",
    steps,
  };
}

export async function buildPlan(input: BuildPlanInput): Promise<BuildPlanResult> {
  const result = await callModel<AgentPlan>({
    role: "analysis",
    system: PLAN_SYSTEM,
    schema: PLAN_SCHEMA,
    maxTokens: 4096,
    messages: [{ role: "user", content: buildPlanMessage(input) }],
  });

  if (result.truncated) throw new Error("Plan response was truncated");
  if (!result.parsed) throw new Error("Plan response could not be parsed");

  const plan = normalizePlan(result.parsed, input.durationDays);
  if (plan.steps.length < MIN_STEPS) {
    throw new Error(
      `Plan came back with ${plan.steps.length} usable steps; need at least ${MIN_STEPS}`
    );
  }

  return { plan, usage: result.usage };
}

function buildPlanMessage(input: BuildPlanInput): string {
  const parts: string[] = [];

  parts.push(`LEAD: ${input.contactName}`);
  parts.push(`LOAN TYPE: ${input.loanType}`);
  parts.push(`PIPELINE STAGE: ${input.stage}`);
  parts.push(`SEQUENCE LENGTH: ${input.durationDays} days.`);
  parts.push(`WHAT THE BROKER WANTS TO HAPPEN: ${input.goal}`);

  /*
   * Placed before the transcript rather than after it. This is the freshest
   * and most reliable input in the whole prompt — a human wrote it about this
   * person minutes ago — and burying it under forty messages invites the model
   * to treat it as a footnote.
   */
  parts.push(
    `THE BROKER'S BRIEF ON THIS LEAD — written just now, and more current than anything below:\n${input.context.trim()}`
  );

  const mf = getMortgageFields(input.prospect);
  if (mf) {
    const fields = Object.entries(mf)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    if (fields) parts.push(`LOAN FILE:\n${fields}`);
  } else {
    parts.push("LOAN FILE: nothing on record.");
  }

  if (input.leadState) {
    const ls = [`What they did with the number: ${input.leadState.pitch_response}`];
    if (input.leadState.evidence) ls.push(`In their words: "${input.leadState.evidence}"`);
    if (input.leadState.suggested_angle) {
      ls.push(`Current read: ${input.leadState.suggested_angle}`);
    }
    parts.push(`THE CLASSIFIER'S READ:\n${ls.join("\n")}`);
  }

  // Audit entries are excluded: "Person moved to campaign" is not something
  // either party said, and a plan step built on one would be about the app.
  const thread = messagesOnly(input.communications)
    .slice(-30)
    .map((c) => {
      const who = isOutbound(c.direction) ? "BROKER" : "LEAD";
      return `[${c.created_at}] ${who}: ${(c.content ?? "").trim()}`;
    })
    .filter((l) => l.split(": ").slice(1).join(": ").length > 0)
    .join("\n");

  parts.push(
    thread
      ? `CONVERSATION SO FAR:\n${thread}`
      : "CONVERSATION SO FAR: nothing on record."
  );

  return parts.join("\n\n");
}
