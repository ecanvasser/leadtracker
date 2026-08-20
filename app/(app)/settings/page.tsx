import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { redirect } from "next/navigation";
import { TelegramSettings } from "@/components/settings/telegram-settings";
import { VoiceProfileSettings } from "@/components/settings/voice-profile-settings";
import {
  GeneralSettings,
  type UserSettings,
} from "@/components/settings/general-settings";
import type { VoiceProfile } from "@/lib/ai/voice-profile-types";
import { resolveCadenceConfig } from "@/lib/cadence/config";
import { modelFor } from "@/lib/ai/models";
import { localDateFor } from "@/lib/time";

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

  const [{ data: link }, { data: settings }, { data: traces }] = await Promise.all([
    supabase.from("telegram_links").select("*").eq("user_id", userId).maybeSingle(),
    service.from("user_settings").select("*").eq("user_id", userId).maybeSingle(),
    // C6 — spend is recorded per queue item rather than as a monthly total, so
    // it can be attributed to the part of the system that spent it.
    service
      .from("daily_queue")
      .select("decision_trace")
      .eq("user_id", userId)
      .eq("queue_date", today)
      .not("decision_trace", "is", null),
  ]);

  let inputTokens = 0;
  let outputTokens = 0;
  let calls = 0;
  for (const row of traces ?? []) {
    const usage = (row.decision_trace as { usage?: Record<string, number> } | null)
      ?.usage;
    if (!usage) continue;
    inputTokens += usage.input_tokens ?? 0;
    outputTokens += usage.output_tokens ?? 0;
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
          draft: modelFor("draft"),
          extract: modelFor("extract"),
        }}
        todaySpend={{ inputTokens, outputTokens, calls }}
      />

      <VoiceProfileSettings
        initialProfile={(settings?.voice_profile as VoiceProfile | null) ?? null}
        initialGeneratedAt={settings?.voice_profile_generated_at ?? null}
      />

      <TelegramSettings userId={userId} initialLink={link} />
    </div>
  );
}
