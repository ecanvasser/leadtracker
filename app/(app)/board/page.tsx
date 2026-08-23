import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { Board } from "@/components/board/board";
import type { LeadState } from "@/lib/insights/lead-state";
import { loadToday } from "@/lib/turn/load";
import type { TodaySection } from "@/lib/turn/types";

export const instant = false;

/** What a card needs to be triageable at a glance. See 4.4. */
export interface BoardMeta {
  pitchResponse: string | null;
  evidenceConfidence: string | null;
  daysSincePitch: number | null;
  /** ISO timestamp of the last outreach, or null if never contacted. */
  lastTouchAt: string | null;
  /**
   * Which Today section this lead falls in, so the board's whose-turn filter
   * (Phase 8 section 3) agrees with the Today screen by construction rather
   * than by two implementations happening to match.
   */
  turn: TodaySection | null;
}

export default async function BoardPage() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();

  if (!authData?.claims) {
    redirect("/login");
  }

  const userId = authData.claims.sub as string;

  const [contactsRes, tasksRes, insightsRes, outreachRes, board] = await Promise.all([
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
    // The whose-turn verdict for every active lead, from the same function
    // /today and the Telegram bot call. Section 5.1's rule applies here too:
    // if the board and Today can disagree about whose move a lead is, that is
    // a bug, and the only way to guarantee they cannot is to ask once.
    loadToday(supabase, userId),
  ]);

  const turnByContact: Record<string, TodaySection> = {};
  for (const row of [...board.your_move, ...board.their_move, ...board.waiting]) {
    turnByContact[row.contact.id] = row.section;
  }

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
      pitchResponse: state?.pitch_response ?? null,
      evidenceConfidence: state?.evidence_confidence ?? null,
      daysSincePitch: state?.days_since_pitch ?? null,
      lastTouchAt: lastTouch[row.contact_id] ?? null,
      turn: turnByContact[row.contact_id] ?? null,
    };
  }

  /*
   * Every remaining contact still needs a meta row. Previously only those with
   * an outreach record got one; since Phase 8 the whose-turn filter needs a
   * verdict for leads that have neither a cache row nor a logged touch —
   * a Needs Quote lead added this morning is squarely "your move" and would
   * otherwise be filtered out of its own section.
   */
  for (const contact of contactsRes.data ?? []) {
    if (!meta[contact.id]) {
      meta[contact.id] = {
        pitchResponse: null,
        evidenceConfidence: null,
        daysSincePitch: null,
        lastTouchAt: lastTouch[contact.id] ?? null,
        turn: turnByContact[contact.id] ?? null,
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
