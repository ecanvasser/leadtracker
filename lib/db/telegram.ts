import { SupabaseClient } from "@supabase/supabase-js";
import { TelegramLink } from "@/types/db";

export async function getTelegramLink(supabase: SupabaseClient, userId: string) {
  const { data, error } = await supabase
    .from("telegram_links")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data as TelegramLink | null;
}

export async function getUserIdByTelegramId(
  supabase: SupabaseClient,
  telegramUserId: number
) {
  const { data, error } = await supabase
    .from("telegram_links")
    .select("user_id")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();

  if (error) throw error;
  return data?.user_id as string | null;
}

export async function createLinkToken(
  supabase: SupabaseClient,
  userId: string
) {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("telegram_link_tokens")
    .insert({ user_id: userId, expires_at: expiresAt })
    .select()
    .single();

  if (error) throw error;
  return data.token as string;
}

export async function redeemLinkToken(
  supabase: SupabaseClient,
  token: string,
  telegramUserId: number
) {
  const { data: tokenRow, error: fetchErr } = await supabase
    .from("telegram_link_tokens")
    .select("*")
    .eq("token", token)
    .eq("used", false)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (fetchErr) throw fetchErr;
  if (!tokenRow) return null;

  const { error: markErr } = await supabase
    .from("telegram_link_tokens")
    .update({ used: true })
    .eq("token", token);

  if (markErr) throw markErr;

  const { error: linkErr } = await supabase.from("telegram_links").upsert(
    {
      user_id: tokenRow.user_id,
      telegram_user_id: telegramUserId,
    },
    { onConflict: "telegram_user_id" }
  );

  if (linkErr) throw linkErr;

  return tokenRow.user_id as string;
}

export async function deleteTelegramLink(
  supabase: SupabaseClient,
  userId: string
) {
  const { error } = await supabase
    .from("telegram_links")
    .delete()
    .eq("user_id", userId);
  if (error) throw error;
}

export async function checkUpdateProcessed(
  supabase: SupabaseClient,
  updateId: number
): Promise<boolean> {
  const { error } = await supabase
    .from("processed_updates")
    .insert({ update_id: updateId });

  if (error) {
    if (error.code === "23505") return true; // unique violation = already processed
    throw error;
  }
  return false;
}
