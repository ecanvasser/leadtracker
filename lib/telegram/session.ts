/**
 * Telegram multi-step flow state.
 *
 * Replaces a module-level Map. On serverless that map lives in one lambda's
 * memory, so the second step of a flow frequently landed on a different
 * instance with an empty map and the bot forgot what it had just been told.
 *
 * withSession loads, hands the handler a mutable object, and persists on the
 * way out — including when the handler returns early, which the command
 * handlers do constantly.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** Flow state is a flat string map; every value is user input or an id. */
export type SessionData = Record<string, string>;

/** Long enough to finish a multi-step flow, short enough to be disposable. */
export const SESSION_TTL_MS = 30 * 60 * 1000;

export interface SessionHandle {
  data: SessionData;
  /** Marks the session for deletion when the handler returns. */
  clear(): void;
}

export async function loadSession(
  supabase: SupabaseClient,
  telegramUserId: number
): Promise<SessionData> {
  const { data, error } = await supabase
    .from("telegram_sessions")
    .select("data, expires_at")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();

  if (error || !data) return {};

  // Expired rows are treated as absent rather than resurrected. The reaper
  // deletes them; this makes correctness independent of when it last ran.
  if (new Date(data.expires_at).getTime() < Date.now()) return {};

  return (data.data as SessionData) ?? {};
}

export async function saveSession(
  supabase: SupabaseClient,
  telegramUserId: number,
  data: SessionData
): Promise<void> {
  const { error } = await supabase.from("telegram_sessions").upsert(
    {
      telegram_user_id: telegramUserId,
      data,
      expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    },
    { onConflict: "telegram_user_id" }
  );
  if (error) throw error;
}

export async function deleteSession(
  supabase: SupabaseClient,
  telegramUserId: number
): Promise<void> {
  await supabase
    .from("telegram_sessions")
    .delete()
    .eq("telegram_user_id", telegramUserId);
}

/**
 * Runs a handler with its session loaded, persisting whatever it did.
 *
 * The try/finally is the point: command handlers return from a dozen places,
 * and requiring each one to remember an explicit save is how state gets lost.
 * A handler that throws still persists — the flow should survive a failed step
 * rather than resetting to the beginning.
 */
export async function withSession<T>(
  supabase: SupabaseClient,
  telegramUserId: number,
  fn: (session: SessionHandle) => Promise<T>
): Promise<T> {
  const initial = await loadSession(supabase, telegramUserId);
  let cleared = false;

  const handle: SessionHandle = {
    data: { ...initial },
    clear() {
      cleared = true;
      for (const key of Object.keys(handle.data)) delete handle.data[key];
    },
  };

  try {
    return await fn(handle);
  } finally {
    try {
      if (cleared || Object.keys(handle.data).length === 0) {
        // Only bother deleting if there was something there.
        if (Object.keys(initial).length > 0) {
          await deleteSession(supabase, telegramUserId);
        }
      } else if (!shallowEqual(initial, handle.data)) {
        await saveSession(supabase, telegramUserId, handle.data);
      }
    } catch (e) {
      // Losing session state is bad but not worth failing the update over —
      // Telegram would retry the whole thing and the user would see the
      // handler's side effects twice.
      console.error("[telegram/session] persist failed:", e);
    }
  }
}

function shallowEqual(a: SessionData, b: SessionData): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a[k] === b[k]);
}
