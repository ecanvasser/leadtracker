/**
 * Redrafting a queue item from a plain-instruction.
 *
 * Goes through the same system prompt, voice profile, exemplars and validator
 * as first-pass drafting. A redraft that skipped the constraints would be the
 * easy way to reintroduce every banned construction — "make it warmer" is
 * exactly the instruction that produces them.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { callModel, DRAFT_TEMPERATURE } from "@/lib/ai/models";
import { buildStablePrefix } from "@/lib/ai/prompts";
import { buildConstraintBlock, type DraftContext } from "@/lib/ai/validate";
import {
  buildGroundingCorpus,
  checkDraft,
  hasIntroducedSelf,
} from "@/lib/ai/draft-validation";
import { exemplarsFor } from "@/lib/ai/voice-profile";
import type { VoiceProfile } from "@/lib/ai/voice-profile-types";
import { getMortgageFields } from "@/lib/bonzo/client";

export interface RevisedDraft {
  body: string;
  subject: string | null;
  validated: boolean;
  violations: string[];
}

const REVISE_CONTRACT = `You are revising one message the broker has already seen.

Apply his instruction and change nothing else. If he asks for it shorter, cut words rather than rewriting from scratch. If he asks to add a point, add it in his register. Do not "improve" what he did not mention.

Return a JSON object:
- "draft_message": the revised message text
- "email_subject": the subject line for an email, or null for SMS

No markdown, no backticks, no preamble.`;

export async function reviseQueueDraft(
  supabase: SupabaseClient,
  userId: string,
  queueItemId: string,
  instruction: string
): Promise<RevisedDraft> {
  const { data: item } = await supabase
    .from("daily_queue")
    .select("id, contact_id, action_type, draft_message, email_subject")
    .eq("id", queueItemId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!item) throw new Error("That queue item no longer exists.");
  if (item.action_type === "call") {
    throw new Error("Call talking points are not redrafted here.");
  }

  const [{ data: contact }, { data: cache }, { data: settings }] = await Promise.all([
    supabase
      .from("contacts")
      .select("name")
      .eq("id", item.contact_id)
      .maybeSingle(),
    supabase
      .from("insights_cache")
      .select("bonzo_prospect_data, bonzo_communication")
      .eq("contact_id", item.contact_id)
      .maybeSingle(),
    supabase
      .from("user_settings")
      .select("broker_display_name, broker_company, voice_profile")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  const comms = (cache?.bonzo_communication ?? []) as {
    content: string | null;
    direction: string;
  }[];
  const prospect = cache?.bonzo_prospect_data as Record<string, unknown> | null;
  const voiceProfile = (settings?.voice_profile as VoiceProfile | null) ?? null;
  const brokerName = settings?.broker_display_name ?? "Eddie Canvasser";
  const brokerCompany = settings?.broker_company ?? "E Mortgage Capital";

  const firstName =
    (prospect?.first_name as string | undefined)?.trim() ||
    contact?.name?.split(" ")[0] ||
    "there";

  const context: DraftContext = {
    channel: item.action_type === "email" ? "email" : "sms",
    firstName,
    brokerName,
    brokerCompany,
    isFirstOutbound: !hasIntroducedSelf(comms, brokerName, brokerCompany),
    allowEmoji: voiceProfile?.uses_emoji ?? false,
    neverUses: voiceProfile?.never_uses ?? [],
    groundingCorpus: buildGroundingCorpus(prospect, comms),
  };

  const system = [
    buildStablePrefix({
      constraints: buildConstraintBlock({
        brokerName,
        brokerCompany,
        allowEmoji: context.allowEmoji,
      }),
      voiceProfile,
      exemplars: exemplarsFor(comms),
    }),
    REVISE_CONTRACT,
  ].join("\n\n");

  // The loan file is restated so the grounding rule has something to hold to —
  // without it a redraft has no way to know which figures are real.
  const mf = getMortgageFields(prospect);
  const fileLines = mf
    ? Object.entries(mf)
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n")
    : "(no loan details on record)";

  const userContent = [
    `LOAN FILE:\n${fileLines}`,
    item.email_subject ? `CURRENT SUBJECT:\n${item.email_subject}` : null,
    `CURRENT MESSAGE:\n${item.draft_message ?? ""}`,
    `INSTRUCTION:\n${instruction}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await callModel<{
    draft_message?: string;
    email_subject?: string | null;
  }>({
    role: "draft",
    system,
    maxTokens: 2048,
    temperature: DRAFT_TEMPERATURE,
    messages: [{ role: "user", content: userContent }],
  });

  if (result.truncated) throw new Error("Redraft was truncated. Try a shorter instruction.");

  const body = (result.parsed?.draft_message ?? "").trim();
  if (!body) throw new Error("Redraft came back empty.");

  const subject =
    context.channel === "email"
      ? (result.parsed?.email_subject ?? item.email_subject ?? "").trim() || null
      : null;

  // Validated but not rejected: the broker asked for this specific change, and
  // refusing to show him the result would be worse than flagging it.
  const violations = checkDraft(body, context).map((v) => v.detail);

  return { body, subject, validated: violations.length === 0, violations };
}
