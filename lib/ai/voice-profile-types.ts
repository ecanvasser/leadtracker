/**
 * Shape of user_settings.voice_profile.
 *
 * Kept in its own module so prompt assembly and the extraction routine can
 * both import it without a cycle.
 */

export interface VoiceProfile {
  greeting_patterns: string[];
  sign_off: string;
  typical_sms_length_chars: number;
  uses_emoji: boolean;
  uses_contractions: boolean;
  capitalization: "sentence" | "lower" | "title" | "mixed";
  exclamation_frequency: "never" | "rare" | "occasional" | "frequent";
  common_phrases: string[];
  never_uses: string[];
}

/** JSON Schema used to constrain the extraction response. */
export const VOICE_PROFILE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    greeting_patterns: {
      type: "array",
      items: { type: "string" },
      description: "Verbatim openers the broker actually uses.",
    },
    sign_off: {
      type: "string",
      description: "How he ends messages. Empty string if he does not sign off.",
    },
    typical_sms_length_chars: {
      type: "integer",
      description: "Median length of his outbound SMS messages in characters.",
    },
    uses_emoji: { type: "boolean" },
    uses_contractions: { type: "boolean" },
    capitalization: {
      type: "string",
      enum: ["sentence", "lower", "title", "mixed"],
    },
    exclamation_frequency: {
      type: "string",
      enum: ["never", "rare", "occasional", "frequent"],
    },
    common_phrases: {
      type: "array",
      items: { type: "string" },
      description: "Short phrases that recur across his messages, verbatim.",
    },
    never_uses: {
      type: "array",
      items: { type: "string" },
      description:
        "Constructions conspicuously absent from his writing that a generic assistant would reach for.",
    },
  },
  required: [
    "greeting_patterns",
    "sign_off",
    "typical_sms_length_chars",
    "uses_emoji",
    "uses_contractions",
    "capitalization",
    "exclamation_frequency",
    "common_phrases",
    "never_uses",
  ],
  additionalProperties: false,
};
