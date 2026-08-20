/**
 * Voice profile extraction.
 *
 * Pulls the broker's real outbound messages from Bonzo and has the model
 * describe how he actually writes. The result is stored on
 * user_settings.voice_profile and injected into every drafting call.
 *
 * Regenerated only on demand from Settings. Doing it automatically would mean
 * a model call on a schedule for something that changes over months, and
 * would also let a run of atypical messages quietly reshape every draft.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getCommunicationHistory } from "@/lib/bonzo/client";
import { callModel, type ModelUsage } from "@/lib/ai/models";
import {
  VOICE_PROFILE_SCHEMA,
  type VoiceProfile,
} from "@/lib/ai/voice-profile-types";

/** How many outbound messages to profile from. */
export const VOICE_SAMPLE_SIZE = 40;

/** Messages shorter than this carry no style signal ("ok", "thanks"). */
const MIN_USEFUL_LENGTH = 15;

const EXTRACTION_SYSTEM = `You are given real SMS and email messages written by one mortgage broker to his clients. Describe how he writes.

Report only what the samples actually show. This profile is used to make generated drafts sound like him, so a wrong detail is worse than a missing one:

- If he never uses emoji in 40 messages, uses_emoji is false.
- If his greetings vary, list the ones that actually recur, verbatim.
- typical_sms_length_chars is the median length of his SMS messages, not an aspiration.
- common_phrases must be phrases you can point to in the samples, copied exactly.
- never_uses is for constructions conspicuously absent from his writing that a generic assistant would reach for — corporate filler, hype words, stock sales lines. Do not list things simply because they did not happen to come up.

Return only the JSON object.`;

export interface OutboundMessage {
  content: string;
  type: string;
  created_at: string;
}

/**
 * Collects recent outbound messages across every connected prospect.
 *
 * Bonzo has no "all my sent messages" endpoint, so this fans out over the
 * enrolled contacts and merges. Bonzo calls only — no model involvement.
 */
export async function collectOutboundMessages(
  supabase: SupabaseClient,
  userId: string,
  limit: number = VOICE_SAMPLE_SIZE
): Promise<OutboundMessage[]> {
  const { data: contacts, error } = await supabase
    .from("contacts")
    .select("bonzo_prospect_id")
    .eq("user_id", userId)
    .not("bonzo_prospect_id", "is", null);

  if (error) throw error;

  const prospectIds = (contacts ?? [])
    .map((c) => c.bonzo_prospect_id as number)
    .filter(Boolean);

  if (prospectIds.length === 0) return [];

  const histories = await Promise.all(
    prospectIds.map((id) => getCommunicationHistory(id).catch(() => []))
  );

  const outbound: OutboundMessage[] = [];
  for (const history of histories) {
    for (const c of history) {
      if (c.direction !== "outbound") continue;
      const content = (c.content ?? "").trim();
      if (content.length < MIN_USEFUL_LENGTH) continue;
      outbound.push({ content, type: c.type, created_at: c.created_at });
    }
  }

  // Newest first, so the profile reflects how he writes now.
  outbound.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  return outbound.slice(0, limit);
}

export interface VoiceProfileResult {
  profile: VoiceProfile;
  sampleSize: number;
  usage: ModelUsage;
}

/**
 * Extracts a profile from a set of messages.
 *
 * Uses the analysis model: this runs a handful of times ever, and a wrong
 * profile silently degrades every draft from then on.
 */
export async function extractVoiceProfile(
  messages: OutboundMessage[]
): Promise<VoiceProfileResult> {
  if (messages.length === 0) {
    throw new Error(
      "No outbound messages found in Bonzo for any connected prospect. " +
        "Connect at least one lead with sent messages, then try again."
    );
  }

  const sms = messages.filter((m) => m.type?.toLowerCase().includes("sms"));
  const sample = messages
    .map((m, i) => `--- MESSAGE ${i + 1} (${m.type}) ---\n${m.content}`)
    .join("\n\n");

  const medianSmsLength = median(sms.map((m) => m.content.length));

  const result = await callModel<VoiceProfile>({
    role: "analysis",
    system: EXTRACTION_SYSTEM,
    schema: VOICE_PROFILE_SCHEMA,
    maxTokens: 4096,
    messages: [
      {
        role: "user",
        content:
          `${messages.length} messages (${sms.length} SMS). ` +
          `Median SMS length in this sample: ${medianSmsLength} characters.\n\n${sample}`,
      },
    ],
  });

  if (result.truncated) {
    throw new Error("Voice profile response was truncated");
  }
  if (!result.parsed) {
    throw new Error("Voice profile response could not be parsed");
  }

  return {
    profile: normalizeProfile(result.parsed, medianSmsLength),
    sampleSize: messages.length,
    usage: result.usage,
  };
}

/**
 * Fills gaps and clamps obviously wrong values.
 *
 * The measured median is trusted over the model's estimate — it is a fact we
 * computed, and an inflated length here makes every draft too long.
 */
export function normalizeProfile(
  raw: Partial<VoiceProfile>,
  measuredMedianSmsLength: number
): VoiceProfile {
  return {
    greeting_patterns: dedupe(raw.greeting_patterns ?? []).slice(0, 8),
    sign_off: (raw.sign_off ?? "").trim(),
    typical_sms_length_chars:
      measuredMedianSmsLength > 0
        ? measuredMedianSmsLength
        : clamp(raw.typical_sms_length_chars ?? 160, 20, 320),
    uses_emoji: Boolean(raw.uses_emoji),
    uses_contractions: raw.uses_contractions !== false,
    capitalization: raw.capitalization ?? "sentence",
    exclamation_frequency: raw.exclamation_frequency ?? "rare",
    common_phrases: dedupe(raw.common_phrases ?? []).slice(0, 12),
    never_uses: dedupe(raw.never_uses ?? []).slice(0, 12),
  };
}

/** Most recent outbound messages to this prospect, for style exemplars (1.3). */
export function exemplarsFor(
  communications: { content: string | null; direction: string }[],
  limit = 10
): string[] {
  return communications
    .filter(
      (c) => c.direction === "outbound" && (c.content ?? "").trim().length >= MIN_USEFUL_LENGTH
    )
    .slice(-limit)
    .map((c) => (c.content ?? "").trim());
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const trimmed = String(item).trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
