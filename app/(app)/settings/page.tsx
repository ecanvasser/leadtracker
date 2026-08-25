import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { redirect } from "next/navigation";
import { TelegramSettings } from "@/components/settings/telegram-settings";
import {
  GeneralSettings,
  type UserSettings,
} from "@/components/settings/general-settings";
import {
  DraftingSettingsPanel,
  type DraftingSettings,
  type DraftingMode,
} from "@/components/settings/drafting-settings";
import { resolveCadenceConfig } from "@/lib/cadence/config";
import { modelFor } from "@/lib/ai/models";
import {
  localDateFor,
  startOfLocalDayUtc,
  endOfLocalDayUtc,
  getUserTimezone,
} from "@/lib/time";

export const instant = false;

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();

  if (!authData?.claims) {
    redirect("/login");
  }

  const userId = authData.claims.sub as string;
  const service = createServiceClient();
  const today = await localDateFor(userId);
  // Needed before the settings row is fetched below, because the ledger query
  // is bounded by the broker's local day rather than UTC.
  const timeZone = await getUserTimezone(userId);

  const [{ data: link }, { data: settings }, { data: usageRows }] = await Promise.all([
    supabase.from("telegram_links").select("*").eq("user_id", userId).maybeSingle(),
    service.from("user_settings").select("*").eq("user_id", userId).maybeSingle(),
    /*
     * C6 — read from the model_usage ledger.
     *
     * This used to sum decision_trace on the day's queue rows, which only ever
     * covered queue generation: classification, prospect analysis, call
     * extraction and drafting all returned their usage to a caller that
     * dropped it. The number shown here was a fraction of the real spend, and
     * confidently so.
     */
    service
      .from("model_usage")
      .select("input_tokens, output_tokens, cache_read_input_tokens")
      .eq("user_id", userId)
      .gte("created_at", startOfLocalDayUtc(today, timeZone).toISOString())
      .lt("created_at", endOfLocalDayUtc(today, timeZone).toISOString()),
  ]);

  let inputTokens = 0;
  let outputTokens = 0;
  let calls = 0;
  for (const row of usageRows ?? []) {
    // Cache reads count towards the budget, so they count here too — the two
    // numbers have to describe the same thing.
    inputTokens += (row.input_tokens ?? 0) + (row.cache_read_input_tokens ?? 0);
    outputTokens += row.output_tokens ?? 0;
    calls += 1;
  }

  const general: UserSettings = {
    timezone: settings?.timezone ?? "America/Los_Angeles",
    broker_display_name: settings?.broker_display_name ?? "Eddie Canvasser",
    broker_company: settings?.broker_company ?? "E Mortgage Capital",
    morning_digest_time: settings?.morning_digest_time ?? "08:00",
    quiet_hours_start: settings?.quiet_hours_start ?? "21:00",
    quiet_hours_end: settings?.quiet_hours_end ?? "08:00",
    working_hours_start: settings?.working_hours_start ?? "08:00",
    working_hours_end: settings?.working_hours_end ?? "19:00",
    daily_token_budget: settings?.daily_token_budget ?? 2_000_000,
    cadence_config: resolveCadenceConfig(settings?.cadence_config),
  };

  const drafting: DraftingSettings = {
    // Absent settings mean off, matching readDraftSettings. A missing row must
    // never render as though drafting were on.
    drafting_mode: (settings?.drafting_mode as DraftingMode) ?? "off",
    draft_schedule_hours: settings?.draft_schedule_hours ?? [3, 24],
    max_redrafts_per_day: settings?.max_redrafts_per_day ?? 3,
    min_hours_since_last_message: settings?.min_hours_since_last_message ?? 6,
  };

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-8">
      <div>
        <h1 className="text-lg font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          How the assistant behaves on your behalf.
        </p>
      </div>

      <GeneralSettings
        initial={general}
        models={{
          analysis: modelFor("analysis"),
          extract: modelFor("extract"),
        }}
        todaySpend={{ inputTokens, outputTokens, calls }}
      />

      <DraftingSettingsPanel initial={drafting} />

      <TelegramSettings userId={userId} initialLink={link} />
    </div>
  );
}
