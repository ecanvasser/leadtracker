import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { Board } from "@/components/board/board";
import type { LeadState } from "@/lib/insights/lead-state";

export const instant = false;

/** What a card needs to be triageable at a glance. See 4.4. */
export interface BoardMeta {
  leadTemp: string | null;
  blocker: string | null;
  blockerConfidence: string | null;
  /** ISO timestamp of the last outreach, or null if never contacted. */
  lastTouchAt: string | null;
}

export default async function BoardPage() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();

  if (!authData?.claims) {
    redirect("/login");
  }

  const userId = authData.claims.sub as string;

  const [contactsRes, tasksRes, insightsRes, outreachRes] = await Promise.all([
    supabase.from("contacts").select("*").order("position", { ascending: true }),
    supabase
      .from("tasks")
      .select("*, contacts(name, loan_type)")
      .eq("is_done", false)
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true }),
    // 4.4 — the state badges. Only the extracted keys are needed, not the
    // whole cached payload.
    supabase.from("insights_cache").select("contact_id, lead_state"),
    // Last touch per contact. Fetched newest-first and reduced below; a
    // per-contact aggregate would need a view, and the volume here is small.
    supabase
      .from("outreach_log")
      .select("contact_id, created_at, status")
      .neq("status", "skipped")
      .order("created_at", { ascending: false })
      .limit(500),
  ]);

  const taskCounts: Record<string, number> = {};
  for (const task of tasksRes.data ?? []) {
    taskCounts[task.contact_id] = (taskCounts[task.contact_id] || 0) + 1;
  }

  const lastTouch: Record<string, string> = {};
  for (const row of outreachRes.data ?? []) {
    // Rows arrive newest-first, so the first seen per contact is the latest.
    if (!lastTouch[row.contact_id]) lastTouch[row.contact_id] = row.created_at;
  }

  const meta: Record<string, BoardMeta> = {};
  for (const row of insightsRes.data ?? []) {
    const state = row.lead_state as LeadState | null;
    meta[row.contact_id] = {
      leadTemp: state?.lead_temp ?? null,
      blocker: state?.blocker && state.blocker !== "none" ? state.blocker : null,
      blockerConfidence: state?.blocker_confidence ?? null,
      lastTouchAt: lastTouch[row.contact_id] ?? null,
    };
  }

  // Contacts with no cache row still need their last-touch date.
  for (const [contactId, at] of Object.entries(lastTouch)) {
    if (!meta[contactId]) {
      meta[contactId] = {
        leadTemp: null,
        blocker: null,
        blockerConfidence: null,
        lastTouchAt: at,
      };
    }
  }

  return (
    <Board
      initialContacts={contactsRes.data ?? []}
      initialTasks={tasksRes.data ?? []}
      initialTaskCounts={taskCounts}
      initialMeta={meta}
      userId={userId}
    />
  );
}
