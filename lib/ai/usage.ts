/**
 * Recording what the models cost, and refusing to spend past the budget.
 *
 * Cost rule C6. The budget column has existed since Phase 0 and was never
 * enforced, because nothing wrote down what had been spent — usage was
 * returned by callModel and dropped by most of its callers. Both halves live
 * here so the ledger and the check can never disagree about what counts.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ModelUsage } from "@/lib/ai/models";
import {
  DEFAULT_TIMEZONE,
  localDate,
  startOfLocalDayUtc,
  endOfLocalDayUtc,
} from "@/lib/time";

/** Which part of the system spent the tokens. */
export type UsagePurpose =
  | "classify"
  | "analyze"
  | "draft_quoted"
  | "redraft"
  | "extract_call_time"
  | "queue_generation";

export interface UsageContext {
  userId: string;
  purpose: UsagePurpose;
  contactId?: string | null;
}

/**
 * Writes one row of spend.
 *
 * Best-effort by design: a ledger write that fails must never fail the call it
 * is describing. The model has already been paid for by then, so throwing here
 * would turn a bookkeeping problem into a lost result and, on a retried job,
 * into a second identical charge.
 */
export async function recordModelUsage(
  supabase: SupabaseClient,
  context: UsageContext,
  usage: Pick<
    ModelUsage,
    "model" | "input_tokens" | "output_tokens" | "cache_read_input_tokens" | "latency_ms"
  >
): Promise<void> {
  try {
    await supabase.from("model_usage").insert({
      user_id: context.userId,
      purpose: context.purpose,
      model: usage.model,
      contact_id: context.contactId ?? null,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      latency_ms: Math.round(usage.latency_ms ?? 0),
    });
  } catch (e) {
    console.error("[ai/usage] could not record model usage:", e);
  }
}

export interface BudgetState {
  /** Billable tokens spent since the start of the broker's local day. */
  used: number;
  budget: number;
  remaining: number;
  exceeded: boolean;
}

/**
 * What the broker has spent today, against the configured ceiling.
 *
 * Cache reads are counted. They are cheaper per token, not free, and a budget
 * that ignored them would drift furthest exactly where caching is heaviest —
 * the long conversation histories this app sends on every classification.
 *
 * "Today" is the broker's local day, not UTC. A budget that resets at 5pm
 * Pacific would free up the evening and starve the morning.
 */
export async function budgetState(
  supabase: SupabaseClient,
  userId: string,
  now: Date = new Date()
): Promise<BudgetState> {
  const { data: settings } = await supabase
    .from("user_settings")
    .select("daily_token_budget, timezone")
    .eq("user_id", userId)
    .maybeSingle();

  const budget = settings?.daily_token_budget ?? 2_000_000;
  const timeZone = settings?.timezone ?? DEFAULT_TIMEZONE;
  const today = localDate(now, timeZone);

  const { data: rows } = await supabase
    .from("model_usage")
    .select("input_tokens, output_tokens, cache_read_input_tokens")
    .eq("user_id", userId)
    .gte("created_at", startOfLocalDayUtc(today, timeZone).toISOString())
    .lt("created_at", endOfLocalDayUtc(today, timeZone).toISOString());

  let used = 0;
  for (const r of rows ?? []) {
    used +=
      (r.input_tokens ?? 0) +
      (r.output_tokens ?? 0) +
      (r.cache_read_input_tokens ?? 0);
  }

  return {
    used,
    budget,
    remaining: Math.max(0, budget - used),
    exceeded: used >= budget,
  };
}

/**
 * The gate every model path calls before spending.
 *
 * Returns true when there is room. On the transition into over-budget it also
 * pushes one Telegram warning, claimed against the local date first so a
 * retried job — or twelve leads in the same drain — cannot send twelve
 * messages.
 *
 * Fails open. If the ledger cannot be read, the app keeps working rather than
 * silently stopping all model work on a transient database error; the budget
 * is a cost guard, not a safety interlock, and a stalled queue is the worse
 * failure.
 */
export async function withinBudget(
  supabase: SupabaseClient,
  userId: string,
  now: Date = new Date()
): Promise<{ ok: boolean; state?: BudgetState }> {
  let state: BudgetState;
  try {
    state = await budgetState(supabase, userId, now);
  } catch (e) {
    console.error("[ai/usage] budget check failed; allowing the call:", e);
    return { ok: true };
  }

  if (!state.exceeded) return { ok: true, state };

  await warnOnce(supabase, userId, state, now).catch((e) =>
    console.error("[ai/usage] budget warning failed:", e)
  );

  return { ok: false, state };
}

async function warnOnce(
  supabase: SupabaseClient,
  userId: string,
  state: BudgetState,
  now: Date
): Promise<void> {
  const { data: settings } = await supabase
    .from("user_settings")
    .select("timezone, last_budget_warning_date")
    .eq("user_id", userId)
    .maybeSingle();

  const timeZone = settings?.timezone ?? DEFAULT_TIMEZONE;
  const today = localDate(now, timeZone);

  if (settings?.last_budget_warning_date === today) return;

  // Claim before sending, and only from the previous value, so two workers
  // racing cannot both win.
  const { error } = await supabase
    .from("user_settings")
    .update({ last_budget_warning_date: today })
    .eq("user_id", userId)
    .or(
      settings?.last_budget_warning_date
        ? `last_budget_warning_date.eq.${settings.last_budget_warning_date}`
        : "last_budget_warning_date.is.null"
    );
  if (error) return;

  const [{ createBot }, { getTelegramLink }] = await Promise.all([
    import("@/lib/telegram/bot"),
    import("@/lib/db/telegram"),
  ]);
  const link = await getTelegramLink(supabase, userId);
  if (!link) return;

  await createBot().api.sendMessage(
    link.telegram_user_id,
    `⚠️ Daily token budget reached — ${state.used.toLocaleString()} of ` +
      `${state.budget.toLocaleString()} tokens.\n\n` +
      `No more drafts or classifications will be generated today. Cards you ` +
      `already have still work, and nothing else in the app is affected. ` +
      `Raise the budget in Settings if this is wrong.`
  );
}
