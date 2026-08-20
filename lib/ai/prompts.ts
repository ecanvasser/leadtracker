/**
 * System prompts.
 *
 * These replace instructions that told the model to "create urgency", "assume
 * the sale", and "never be desperate or apologetic". Those produced exactly
 * the tone the broker did not want: messages that read as marketing copy and
 * needed heavy editing before he would send them.
 *
 * The organising idea is restraint. The prospect should read a message and
 * think a busy professional typed it on a phone between calls.
 *
 * Prompt assembly follows a fixed order so the stable portion can later be
 * cached without a rewrite (see buildStablePrefix).
 */

import type { VoiceProfile } from "@/lib/ai/voice-profile-types";

/**
 * Drafting instructions.
 *
 * Deliberately short. A long prompt full of adjectives is itself a source of
 * florid output — the model mirrors the register it is addressed in.
 */
export const DRAFT_SYSTEM_BASE = `You draft SMS and email messages that a mortgage broker sends to his own leads from his own phone. He reviews every message before it goes out, and edits anything that does not sound like him.

Write what he would actually type. That means:

- Plain and short. Say one thing. Stop.
- Factual. Reference something concrete from this specific conversation or from the loan file.
- No sales register. Do not build urgency, do not sell, do not flatter, do not perform enthusiasm.
- No throat-clearing. Get to the point in the first sentence.
- Ordinary punctuation. A message rarely needs more than a period.

The most common failure is writing something that is technically polite and completely empty — a message that could have been sent to any lead on any day. If you cannot find a specific reason to send this message, say so rather than filling the space.

Never state a rate, payment, term, program name, or dollar figure that does not appear in the loan file or earlier in the conversation. If the message needs a number you were not given, ask the prospect for it or say you will find out. Inventing a number is the worst thing you can do here.

For a CALL action, do not write a message. Write three or four short talking points: what to open with, what to ask, what to offer. They are notes for a person who already knows this file, not a script.`;

/**
 * Analysis instructions for the contact-page read of a prospect.
 *
 * Same restraint, plus an explicit licence to report that nothing is
 * happening. The previous prompt always produced a confident next step, which
 * is how dead leads kept generating "just checking in" messages.
 */
export const ANALYSIS_SYSTEM = `You read a mortgage prospect's history and report where things actually stand.

You will receive the prospect's profile and loan details, the full message history with the broker, and any internal notes.

Be accurate before being useful. Specifically:

- Say what the history shows, not what would be encouraging. If the prospect has not replied in six weeks, that is the finding.
- Ground every claim in something in the record. Quote or reference it.
- If the evidence does not support a conclusion, say the evidence is thin. "Unknown" is a valid and useful answer.
- Do not invent numbers. Every figure you mention must appear in the loan file or the messages.

You may conclude that the right next step is to do nothing. A lead that is blocked on something outside the broker's control does not need a message; it needs a reason to be contacted, and if there is no such reason, say so.

Write in plain sentences. No sales language.`;

/**
 * Renders a voice profile into prompt text.
 *
 * Kept separate from the exemplars because the two do different jobs: this
 * describes the rules, the exemplars show the result. The spec asks for both,
 * and verbatim examples carry far more signal than any description.
 */
export function renderVoiceProfile(profile: VoiceProfile | null): string {
  if (!profile) {
    return `BROKER'S VOICE: not yet profiled. Default to short, plain, lowercase-leaning sentences with no emoji and no exclamation points.`;
  }

  const lines: string[] = ["BROKER'S VOICE (extracted from his real messages):"];

  if (profile.greeting_patterns?.length) {
    lines.push(`- Opens with: ${profile.greeting_patterns.map(q).join(", ")}`);
  }
  if (profile.sign_off) lines.push(`- Signs off with: ${q(profile.sign_off)}`);
  if (typeof profile.typical_sms_length_chars === "number") {
    lines.push(
      `- Typical SMS length: about ${profile.typical_sms_length_chars} characters`
    );
  }
  lines.push(`- Emoji: ${profile.uses_emoji ? "occasionally" : "never"}`);
  lines.push(
    `- Contractions: ${profile.uses_contractions ? "yes, writes naturally" : "no, writes them out"}`
  );
  if (profile.capitalization) {
    lines.push(`- Capitalization: ${profile.capitalization}`);
  }
  if (profile.exclamation_frequency) {
    lines.push(`- Exclamation points: ${profile.exclamation_frequency}`);
  }
  if (profile.common_phrases?.length) {
    lines.push(`- Phrases he actually uses: ${profile.common_phrases.map(q).join(", ")}`);
  }
  if (profile.never_uses?.length) {
    lines.push(`- Never writes: ${profile.never_uses.map(q).join(", ")}`);
  }

  return lines.join("\n");
}

/**
 * Renders verbatim outbound messages as examples to imitate.
 *
 * These are the broker's real words. They are the single most effective part
 * of the prompt — a prose description of a writing style is a much weaker
 * signal than ten samples of it.
 */
export function renderStyleExemplars(messages: string[]): string {
  if (messages.length === 0) {
    return `STYLE EXAMPLES: none available yet.`;
  }
  const numbered = messages
    .map((m, i) => `${i + 1}. ${m.trim().replace(/\s+/g, " ")}`)
    .join("\n");
  return `STYLE EXAMPLES — real messages this broker has sent. Match this register, length and punctuation. Do not copy their content:\n${numbered}`;
}

function q(s: string): string {
  return `"${s}"`;
}

export interface StablePrefixInput {
  /** Constraint block from lib/ai/validate.ts, appended to the base prompt. */
  constraints: string;
  voiceProfile: VoiceProfile | null;
  exemplars: string[];
}

/**
 * Builds the drafting system prompt.
 *
 * Order is fixed and deliberate: system prompt -> voice profile -> style
 * exemplars. Nothing per-lead may be interpolated here; per-lead context goes
 * in the user message, strictly after this block.
 *
 * That ordering is what makes prompt caching possible later without a
 * rewrite. Caching is a prefix match, so any per-lead byte in here would
 * invalidate the cache on every single request and the feature would silently
 * do nothing. At current volume caching is not worth enabling — the
 * breakpoint below is left commented at the boundary with that note.
 */
export function buildStablePrefix(input: StablePrefixInput): string {
  return [
    DRAFT_SYSTEM_BASE,
    input.constraints,
    renderVoiceProfile(input.voiceProfile),
    renderStyleExemplars(input.exemplars),
  ].join("\n\n");

  // To enable prompt caching, return this instead and pass it as the `system`
  // array. The breakpoint goes at the end of the stable block; everything
  // per-lead already lives in the user message, so the prefix stays byte
  // identical across leads.
  //
  //   return [{
  //     type: "text",
  //     text: <the joined string above>,
  //     cache_control: { type: "ephemeral" },
  //   }];
  //
  // Cache reads bill at 10% of standard input and stack with the Batch API's
  // 50%, so pre-generating the morning queue overnight would qualify for both.
  // Verify with usage.cache_read_input_tokens — if it stays zero across
  // requests, something per-lead has leaked into the prefix.
}
