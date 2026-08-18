import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { TelegramSettings } from "@/components/settings/telegram-settings";

export const instant = false;

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();

  if (!authData?.claims) {
    redirect("/login");
  }

  const userId = authData.claims.sub as string;

  const { data: link } = await supabase
    .from("telegram_links")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  return (
    <div className="max-w-lg mx-auto p-6 space-y-8">
      <div>
        <h1 className="text-lg font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your account and integrations.
        </p>
      </div>
      <TelegramSettings userId={userId} initialLink={link} />
    </div>
  );
}
