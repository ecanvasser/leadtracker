/**
 * Model routing and the single place any Anthropic request is built.
 *
 * No model string is hardcoded anywhere else in the codebase. Routing follows
 * the cost plan: reasoning-heavy, low-volume work goes to the expensive model;
 * drafting to the mid tier; mechanical extraction to the cheap one.
 */

import Anthropic from "@anthropic-ai/sdk";

export type ModelRole = "analysis" | "draft" | "extract";

/**
 * Defaults if the env var is unset.
 *
 * - analysis: lead-state classification and voice-profile extraction. Judgment
 *   matters most and volume is low (a handful of calls per lead per week).
 * - draft:    message drafting and redrafts. The high-volume path.
 * - extract:  call-time and commitment detection. Pattern matching, not
 *   judgment, and only reached when a regex/date parse is ambiguous.
 */
const DEFAULT_MODELS: Record<ModelRole, string> = {
  analysis: "claude-opus-5",
  draft: "claude-sonnet-5",
  extract: "claude-haiku-4-5",
};

const ENV_VAR: Record<ModelRole, string> = {
  analysis: "ANTHROPIC_MODEL_ANALYSIS",
  draft: "ANTHROPIC_MODEL_DRAFT",
  extract: "ANTHROPIC_MODEL_EXTRACT",
};

export function modelFor(role: ModelRole): string {
  const configured = process.env[ENV_VAR[role]]?.trim();
  return configured || DEFAULT_MODELS[role];
}

/**
 * Whether a model still accepts temperature / top_p / top_k.
 *
 * The rework spec asked for `temperature: 0.3` on drafting calls to curb
 * florid output. Sampling parameters were **removed** on Claude Sonnet 5,
 * Opus 5, and the Opus 4.7/4.8 family — sending temperature to those returns
 * a 400 and the call fails outright.
 *
 * Tone is therefore controlled by the hard constraints in lib/ai/validate.ts,
 * which reject a draft outright rather than nudging a distribution. This
 * function exists so that pinning an older model via env var transparently
 * restores the temperature behaviour without a code change.
 */
export function supportsSampling(model: string): boolean {
  const noSampling = [
    "claude-fable-5",
    "claude-mythos-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-5",
  ];
  return !noSampling.some((m) => model.startsWith(m));
}

/** Applied only to models that still accept it. See supportsSampling. */
export const DRAFT_TEMPERATURE = 0.3;

export interface ModelUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  latency_ms: number;
  /** Present only when the model accepted a sampling parameter. */
  temperature?: number;
}

export interface CallOptions {
  role: ModelRole;
  system: string | Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  maxTokens?: number;
  /** JSON Schema. When set, the response is constrained to match it. */
  schema?: Record<string, unknown>;
  /** Applies only where the configured model accepts sampling. */
  temperature?: number;
}

export interface CallResult<T = unknown> {
  text: string;
  parsed: T | null;
  usage: ModelUsage;
  stopReason: string | null;
  /** True when the response was cut off — callers must treat this as failure. */
  truncated: boolean;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

/** Reset between tests. */
export function resetClient(): void {
  client = null;
}

/**
 * Issues one request and returns the text, parsed JSON, and usage.
 *
 * Usage is returned rather than logged so callers can write it into
 * decision_trace — the point is being able to see which part of the system is
 * spending, not just a monthly total.
 */
export async function callModel<T = unknown>(
  opts: CallOptions
): Promise<CallResult<T>> {
  const model = modelFor(opts.role);
  const started = Date.now();

  const temperature =
    opts.temperature !== undefined && supportsSampling(model)
      ? opts.temperature
      : undefined;

  const response = await getClient().messages.create({
    model,
    // Never lowballed: hitting the cap truncates mid-thought and costs a retry.
    max_tokens: opts.maxTokens ?? 8192,
    system: opts.system,
    messages: opts.messages,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(opts.schema
      ? { output_config: { format: { type: "json_schema", schema: opts.schema } } }
      : {}),
  } as Anthropic.MessageCreateParamsNonStreaming);

  const latency_ms = Date.now() - started;

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const truncated = response.stop_reason === "max_tokens";

  let parsed: T | null = null;
  if (!truncated) {
    try {
      parsed = JSON.parse(stripCodeFence(text)) as T;
    } catch {
      parsed = null;
    }
  }

  return {
    text,
    parsed,
    usage: {
      model,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? undefined,
      latency_ms,
      ...(temperature !== undefined ? { temperature } : {}),
    },
    stopReason: response.stop_reason,
    truncated,
  };
}

/**
 * Tolerates a fenced response. With output_config the model returns bare JSON,
 * but this path is also used for unconstrained calls.
 */
export function stripCodeFence(text: string): string {
  return text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}
