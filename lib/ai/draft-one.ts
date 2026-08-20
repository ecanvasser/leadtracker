/**
 * Drafting a single queue item.
 *
 * The batch path in generate/route.ts chunks four leads per call to amortise
 * the ~2,300-token stable prefix. That tradeoff is right for the morning run
 * and wrong here: an inbound reply is one lead, and it must not wait for three
 * more to arrive before anything is drafted.
 *
 * Same prompt, same voice profile, same exemplars, same validator — only the
 * batching differs.
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
import type { LeadState } from "@/lib/insights/lead-state";

export interface SingleDraftResult {
  body: string;
  subject: string | null;
  validated: boolean;
  violations: string[];
}

const REPLY_CONTRACT = `Return a JSON object:
- "draft_message": the message text
- "email_subject": the subject line for an email, or null for SMS

No markdown, no backticks, no preamble.`;

export async function draftSingleQueueItem(
  supabase: SupabaseClient,
  userId: string,
  queueItemId: string
): Promise<SingleDraftResult> {
  const { data: item } = await supabase
    .from("daily_queue")
    .select("id, contact_id, action_type, priority_reason, decision_trace")
    .eq("id", queueItemId)
    .maybeSingle();

  if (!item) throw new Error("Queue item not found");

  const [{ data: contact }, { data: cache }, { data: settings }] = await Promise.all([
    supabase.from("contacts").select("name, created_at").eq("id", item.contact_id).maybeSingle(),
    supabase
      .from("insights_cache")
      .select("bonzo_prospect_data, bonzo_communication, lead_state")
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
    type: string;
    created_at: string;
  }[];
  const prospect = cache?.bonzo_prospect_data as Record<string, unknown> | null;
  const leadState = (cache?.lead_state as LeadState | null) ?? null;
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
    REPLY_CONTRACT,
  ].join("\n\n");

  const userContent = buildContext(item.priority_reason, prospect, comms, leadState);

  const attempt = async (correction: string | null) => {
    const result = await callModel<{
      draft_message?: string;
      email_subject?: string | null;
    }>({
      role: "draft",
      system,
      maxTokens: 2048,
      temperature: DRAFT_TEMPERATURE,
      messages: [
        {
          role: "user",
          content: correction ? `${userContent}\n\n${correction}` : userContent,
        },
      ],
    });

    if (result.truncated) throw new Error("Draft was truncated");
    const body = (result.parsed?.draft_message ?? "").trim();
    if (!body) throw new Error("Draft came back empty");
    const subject =
      context.channel === "email"
        ? (result.parsed?.email_subject ?? "").trim() || null
        : null;
    return { body, subject };
  };

  let { body, subject } = await attempt(null);
  let violations = checkDraft(body, context);

  // One corrective retry, then surface flagged. Never a loop.
  if (violations.length > 0) {
    const correction =
      `Your draft broke the hard rules:\n` +
      violations.map((v) => `  - ${v.detail}`).join("\n") +
      `\n\nRewrite it, fixing exactly what is named and changing nothing else.`;
    try {
      const retried = await attempt(correction);
      const retryViolations = checkDraft(retried.body, context);
      // Keep the retry only if it is actually better.
      if (retryViolations.length < violations.length) {
        body = retried.body;
        subject = retried.subject;
        violations = retryViolations;
      }
    } catch {
      // Keep the first draft; a failed retry is not a reason to show nothing.
    }
  }

  const trace = (item.decision_trace as Record<string, unknown> | null) ?? {};

  await supabase
    .from("daily_queue")
    .update({
      draft_message: body,
      email_subject: subject,
      decision_trace: {
        ...trace,
        validation: {
          validated: violations.length === 0,
          reasons: violations.map((v) => v.detail),
        },
      },
    })
    .eq("id", queueItemId);

  return {
    body,
    subject,
    validated: violations.length === 0,
    violations: violations.map((v) => v.detail),
  };
}

function buildContext(
  reason: string,
  prospect: Record<string, unknown> | null,
  comms: { content: string | null; direction: string; created_at: string }[],
  leadState: LeadState | null
): string {
  const parts: string[] = [`WHY THIS MESSAGE: ${reason}`];

  const mf = getMortgageFields(prospect);
  if (mf) {
    const fields = Object.entries(mf)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    if (fields) parts.push(`LOAN FILE:\n${fields}`);
  }

  if (leadState) {
    const bits = [`state: ${leadState.lead_temp}`];
    if (leadState.blocker !== "none") bits.push(`blocker: ${leadState.blocker}`);
    if (leadState.unblock_path) bits.push(`what would move it: ${leadState.unblock_path}`);
    parts.push(`LEAD STATE:\n${bits.join("\n")}`);
  }

  const recent = [...comms]
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .slice(-15)
    .map((c) => {
      const who = c.direction === "outbound" ? "BROKER" : "PROSPECT";
      return `[${c.created_at.slice(0, 10)}] ${who}: ${c.content?.trim() || "(no content)"}`;
    })
    .join("\n");

  parts.push(
    recent
      ? `CONVERSATION:\n${recent}`
      : "CONVERSATION: none yet — this is a first outreach."
  );

  return parts.join("\n\n");
}
