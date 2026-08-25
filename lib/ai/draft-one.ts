/**
 * Drafting for one lead in the quoted window (Phase 8 section 6A).
 *
 * This reintroduces drafting, narrowly, after Phase 7 removed a
 * general-purpose version for good reasons. The difference is not the code,
 * it is the context. The retired system drafted cold outreach for any hot
 * lead, with a bug that left it writing from almost nothing, and it filled the
 * vacuum with enthusiasm. This one drafts for a lead quoted hours ago: it has
 * the loan numbers that were sent, the full conversation, the lead's reaction
 * to the price, and the classifier's read of what they did with it.
 *
 * **Scope: leads in `quoted_follow_up`, inside the park window, only.** Not
 * before, not after. `isInDraftScope` is the single gate and every caller goes
 * through it.
 *
 * Two things deliberately not rebuilt (6A.2):
 *   - Voice-profile extraction. The structured profile was overhead; the part
 *     that worked was the real messages. Style now comes from passing the last
 *     ten verbatim outbound messages as exemplars.
 *   - Chunked batch drafting. Volume is a handful a day. One lead at a time.
 */

import { callModel, DRAFT_TEMPERATURE, type ModelUsage } from "@/lib/ai/models";
import {
  buildConstraintBlock,
  validateDraft,
  type Channel,
  type DraftContext,
  type Violation,
} from "@/lib/ai/validate";
import {
  getMortgageFields,
  isOutbound,
  messagesOnly,
  type BonzoCommunication,
  type BonzoProspect,
} from "@/lib/bonzo/client";
import type { LeadState } from "@/lib/insights/lead-state";
import type { AllStages } from "@/types/db";

/** How many of Eddie's own messages go in as style exemplars (6A.2). */
export const STYLE_EXEMPLAR_COUNT = 10;

export interface DraftScopeInput {
  stage: AllStages;
  /** When the lead entered Quoted – Follow Up. */
  stageChangedAt: string | null;
  /** The handoff threshold in days — the far edge of the window. */
  windowDays: number;
  now: Date;
}

/**
 * The scope gate. Section 7 is explicit that drafting must not extend to Hot
 * Lead, Needs Quote, or anything post-handoff, and 6A.1 bounds it to the park
 * window, so both halves are checked here rather than assumed by callers.
 */
export function isInDraftScope(input: DraftScopeInput): {
  inScope: boolean;
  reason?: string;
} {
  if (input.stage !== "quoted_follow_up") {
    return { inScope: false, reason: `stage is ${input.stage}, not quoted_follow_up` };
  }
  if (!input.stageChangedAt) {
    // Without a pitch time there is no window to be inside. Refusing is the
    // safe direction: the alternative is drafting to someone on the strength
    // of not knowing when they were quoted.
    return { inScope: false, reason: "no recorded pitch time" };
  }

  const elapsedMs = input.now.getTime() - new Date(input.stageChangedAt).getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return { inScope: false, reason: "pitch time is unreadable" };
  }
  if (elapsedMs > input.windowDays * 86_400_000) {
    return { inScope: false, reason: "past the handoff window" };
  }
  return { inScope: true };
}

export interface DraftOneInput {
  channel: Channel;
  contactName: string;
  brokerName: string;
  brokerCompany: string;
  prospect: BonzoProspect | null;
  communications: BonzoCommunication[];
  leadState: LeadState | null;
  /** Hours since the quote went out, for the prompt's sense of timing. */
  hoursSincePitch: number | null;
  /**
   * Set when this draft is one step of a deployed agent's plan.
   *
   * Carries Eddie's own brief about the lead and the step's angle. Both
   * outrank the classifier's read, which is inferred from a transcript, while
   * the brief was typed by a person who has spoken to them.
   */
  agent?: {
    brief: string;
    angle: string;
    hypothesis: string;
    stepNumber: number;
    totalSteps: number;
  };
  /** An instruction from Eddie, on the redraft path only. */
  instruction?: string;
  /** The draft being revised, on the redraft path only. */
  previous?: string;
}

export interface DraftOneResult {
  body: string;
  /** False when a draft is surfaced despite failing validation twice (6A.3). */
  validated: boolean;
  violations: Violation[];
  attempts: number;
  usage: ModelUsage[];
}

/** Everything a figure in the draft may be grounded against. */
export function buildGroundingCorpus(
  prospect: BonzoProspect | null,
  communications: Pick<BonzoCommunication, "content">[]
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
 * Eddie's last N outbound messages, newest last.
 *
 * This is the whole of what replaced the voice profile, and 6A.2 is right
 * that it is the part that worked: a model shown ten real messages writes
 * something closer to them than one shown an adjective list describing them.
 */
export function styleExemplars(
  communications: BonzoCommunication[],
  limit: number = STYLE_EXEMPLAR_COUNT
): string[] {
  return messagesOnly(communications)
    .filter((c) => isOutbound(c.direction) && (c.content ?? "").trim().length > 0)
    .sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    )
    .slice(-limit)
    .map((c) => (c.content ?? "").trim());
}

const DRAFT_SYSTEM_PREFIX = `You draft one short message from a mortgage broker to a prospect he has already quoted.

He sent them numbers hours or days ago. They have either reacted to the price or gone quiet. Your job is to write the message he would send next — not a nudge, not a check-in, but something that moves the specific conversation forward.

WHY THEY WENT QUIET, AND WHAT THE MESSAGE IS ACTUALLY FOR

A lead who has been quoted and stopped replying is almost never stuck on a logistical step. Something is holding them back, and in this business it is one of three things:

1. An internal battle. They are hesitating. The outcome is not clear to them and committing feels risky.
2. Money. They do not have it, or they do not want to spend it on this right now.
3. A better promise. Another lender told them something better. It may well not be true, but they believe it.

The message's job is to find out which one it is. Not to advance the paperwork — to get them to say the thing they have not said.

That means:

ASKING THE STATUS OF A STEP IS A WASTED MESSAGE. "Did the payment go through", "did you get a chance to look", "any update on the documents" — all answerable with one word or with silence, and none of them tell him anything he does not already know. If he can look it up himself, it is not worth asking.

NAME THE LIKELY BLOCKER AND MAKE IT CHEAP TO ADMIT. A lead who will never volunteer "I can't afford this right now" will often confirm it when it is put to them directly and without judgement. Say the thing they are avoiding saying, and give them an easy way to agree with it.

GIVE THEM SOMETHING TO PUSH BACK ON. A stated assumption they can correct gets a reply. An open invitation to talk does not.

READ THE EVIDENCE FOR WHICH BLOCKER IT IS. Silence straight after a number points at money or a competing offer. Silence after they agreed to something points at hesitation. Silence after they asked about a specific term points at something they were told elsewhere.

NEVER OFFER TO COVER ANYTHING. Not a fee, not a cost, not a deposit — not as a gesture and not as a hypothetical. He does not pay his clients' costs and a draft that hints he might is worse than no draft.

Write the way he writes: the examples of his own messages below are the target, not a style described in the abstract. Match their length, their punctuation, their bluntness.

Return only the message body. No subject line, no greeting block, no signature, no commentary.`;

function buildUserMessage(input: DraftOneInput): string {
  const parts: string[] = [];

  parts.push(`PROSPECT: ${input.contactName}`);
  parts.push(`CHANNEL: ${input.channel}`);
  parts.push(
    input.hoursSincePitch === null
      ? "TIME SINCE THE QUOTE: unknown."
      : `TIME SINCE THE QUOTE: about ${Math.round(input.hoursSincePitch)} hours.`
  );

  const mf = getMortgageFields(input.prospect);
  if (mf) {
    const fields = Object.entries(mf)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    if (fields) parts.push(`LOAN FILE — the only figures you may use:\n${fields}`);
  } else {
    parts.push(
      "LOAN FILE: nothing on record. Do not state any figure at all; ask instead."
    );
  }

  if (input.leadState) {
    const ls: string[] = [
      `What they did with the number: ${input.leadState.pitch_response}`,
    ];
    if (input.leadState.evidence) {
      ls.push(`In their words: "${input.leadState.evidence}"`);
    }
    if (input.leadState.suggested_angle) {
      ls.push(`Angle to lead with: ${input.leadState.suggested_angle}`);
    }
    parts.push(`THE READ ON THIS LEAD:\n${ls.join("\n")}`);
  }

  const thread = messagesOnly(input.communications)
    .slice(-20)
    .map((c) => {
      const who = isOutbound(c.direction) ? input.brokerName : input.contactName;
      return `${who}: ${(c.content ?? "").trim()}`;
    })
    .filter((l) => l.split(": ").slice(1).join(": ").length > 0)
    .join("\n");
  if (thread) parts.push(`CONVERSATION SO FAR:\n${thread}`);

  if (input.agent) {
    /*
     * Placed last among the context blocks and before the style exemplars, so
     * it is the freshest thing in the prompt. The brief is the reason this
     * draft is allowed to exist outside the quoted window at all — see
     * lib/agents/types.ts — and it must not read as one more note among many.
     */
    parts.push(
      `THIS IS TOUCH ${input.agent.stepNumber} OF ${input.agent.totalSteps} IN A PLAN HE APPROVED.
` +
        `What this touch is about: ${input.agent.angle}
` +
        `What it assumes is holding them back: ${input.agent.hypothesis}

` +
        `HIS OWN BRIEF ON THIS LEAD — he wrote this himself, and it outranks ` +
        `anything inferred from the transcript:
${input.agent.brief.trim()}

` +
        `Write the touch described above. Do not write a general follow-up, and ` +
        `do not repeat an angle an earlier touch already used.`
    );
  }

  const exemplars = styleExemplars(input.communications);
  if (exemplars.length > 0) {
    parts.push(
      `HOW HE WRITES — his own recent messages, match these:\n${exemplars
        .map((e) => `- ${e}`)
        .join("\n")}`
    );
  }

  if (input.instruction && input.previous) {
    parts.push(
      `YOUR PREVIOUS DRAFT:\n${input.previous}\n\n` +
        `HE ASKED FOR A CHANGE: ${input.instruction}\n` +
        `Rewrite it accordingly. Change what he asked for and leave the rest alone.`
    );
  }

  return parts.join("\n\n");
}

/**
 * Renders violations as a correction instruction for the single retry.
 *
 * Names the specific rule broken rather than restating the rulebook — the
 * rulebook is already in the system prompt, and repeating it wholesale tends
 * to produce a draft that over-corrects into blandness.
 */
export function buildRetryInstruction(violations: Violation[]): string {
  return (
    `Your draft was rejected. Fix exactly what is named below and change nothing else. ` +
    `Do not become vaguer to be safe.\n\n` +
    violations.map((v) => `- ${v.detail}`).join("\n")
  );
}

/**
 * Drafts one message, validating and retrying at most once.
 *
 * The retry policy is rigid on purpose (6A.3): attempt, validate, one
 * corrective retry, then surface regardless — flagged if it still fails. Never
 * a loop. A redraft loop is the obvious runaway cost risk in this feature, and
 * the cap belongs in the control flow rather than in a budget check that
 * notices afterwards.
 */
export async function draftOne(input: DraftOneInput): Promise<DraftOneResult> {
  const ctx: DraftContext = {
    channel: input.channel,
    brokerName: input.brokerName,
    brokerCompany: input.brokerCompany,
    groundingCorpus: buildGroundingCorpus(input.prospect, input.communications),
    // Specificity is measured against the loan file and what the lead said,
    // never against Eddie's own past messages — see DraftContext.
    specificityCorpus: buildGroundingCorpus(
      input.prospect,
      messagesOnly(input.communications).filter((c) => !isOutbound(c.direction))
    ),
  };

  const system = [
    { type: "text" as const, text: DRAFT_SYSTEM_PREFIX },
    {
      type: "text" as const,
      text: buildConstraintBlock({
        brokerName: input.brokerName,
        brokerCompany: input.brokerCompany,
      }),
    },
  ];

  const usage: ModelUsage[] = [];
  const userMessage = buildUserMessage(input);

  let body = "";
  let violations: Violation[] = [];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const messages =
      attempt === 1
        ? [{ role: "user" as const, content: userMessage }]
        : [
            { role: "user" as const, content: userMessage },
            { role: "assistant" as const, content: body },
            { role: "user" as const, content: buildRetryInstruction(violations) },
          ];

    const result = await callModel({
      role: "draft",
      system,
      messages,
      maxTokens: 1024,
      /*
       * 6A.6 asks for temperature 0.3 on every drafting call. The model layer
       * applies it only where the configured model still accepts a sampling
       * parameter — Sonnet 5 and Opus 5 reject it with a 400. On those, tone
       * is held by the validator rejecting output rather than by nudging a
       * distribution, which is the stronger mechanism anyway.
       */
      temperature: DRAFT_TEMPERATURE,
    });

    usage.push(result.usage);
    body = result.text.trim();

    // A truncated response is a failure, not a short message: it stops
    // mid-sentence and would go out that way.
    violations = result.truncated
      ? [{ rule: "truncated", detail: "Response hit the token cap mid-message" }]
      : validateDraft(body, ctx);

    if (violations.length === 0) {
      return { body, validated: true, violations: [], attempts: attempt, usage };
    }
  }

  // Twice is enough. Surface it flagged rather than spending more.
  return { body, validated: false, violations, attempts: 2, usage };
}
