/**
 * Loads everything computeTurn needs and returns the three Today sections.
 *
 * This is the function section 5.1 requires the web page and the Telegram bot
 * to share. Not "similar logic in both places" — the same function. If the
 * screen and the bot can ever disagree about the three counts, the numbers
 * stop being trustworthy, and the counts are the product.
 *
 * Five queries, none of them per-contact. An N+1 here would be invisible at
 * twenty leads and painful at two hundred, and this runs on every page load
 * and every /today in Telegram.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { LeadState } from "@/lib/insights/lead-state";
import { computeTurn, groupToday, isTodayActive, type TodayBoard } from "@/lib/turn/compute";
import {
  DEFAULT_TURN_SETTINGS,
  type TurnCache,
  type TurnContact,
  type TurnHandoff,
  type TurnResult,
  type TurnSettings,
} from "@/lib/turn/types";
import { DEFAULT_TIMEZONE, safeTimezone } from "@/lib/time";
import { TERMINAL_STAGES } from "@/types/db";

export interface LoadTodayResult extends TodayBoard {
  timeZone: string;
  settings: TurnSettings;
}

export async function loadToday(
  supabase: SupabaseClient,
  userId: string,
  now: Date = new Date()
): Promise<LoadTodayResult> {
  const [{ data: settingsRow }, { data: contactRows }] = await Promise.all([
    supabase
      .from("user_settings")
      .select("timezone, today_overdue_days, today_recent_touch_hours")
      .eq("user_id", userId)
      .maybeSingle(),
    supabase
      .from("contacts")
      .select(
        "id, name, loan_type, stage, stage_changed_at, bonzo_prospect_id, insights_enabled"
      )
      .eq("user_id", userId)
      // The same exclusion the Today screen's counts are defined over. A dead
      // deal in the Waiting list is noise, not reassurance.
      .not("stage", "in", `(${TERMINAL_STAGES.join(",")})`),
  ]);

  const timeZone = safeTimezone(settingsRow?.timezone ?? DEFAULT_TIMEZONE);
  const settings: TurnSettings = {
    overdueDays: settingsRow?.today_overdue_days ?? DEFAULT_TURN_SETTINGS.overdueDays,
    recentTouchHours:
      settingsRow?.today_recent_touch_hours ?? DEFAULT_TURN_SETTINGS.recentTouchHours,
  };

  const contacts = (contactRows ?? []) as TurnContact[];
  if (contacts.length === 0) {
    return { ...groupToday([]), timeZone, settings };
  }

  const ids = contacts.map((c) => c.id);

  const [{ data: cacheRows }, { data: taskRows }, { data: callRows }, { data: actedRows }, handoffs] =
    await Promise.all([
      supabase
        .from("insights_cache")
        .select("contact_id, last_inbound_at, last_outbound_at, last_message_at, lead_state")
        .in("contact_id", ids),
      supabase
        .from("tasks")
        .select("id, contact_id, title, due_date, is_done")
        .eq("user_id", userId)
        .eq("is_done", false)
        .in("contact_id", ids),
      supabase
        .from("scheduled_calls")
        .select("contact_id, scheduled_at, status")
        .eq("user_id", userId)
        .eq("status", "confirmed")
        .gte("scheduled_at", now.toISOString())
        .in("contact_id", ids),
      /*
       * What Eddie has done from inside this app, which Bonzo does not know
       * about until the next sweep.
       *
       * This is what makes Done on a Today row mean something immediately.
       * He reads "Dana asked about closing costs", answers her in Bonzo, and
       * taps Done — without this the row would sit in Your move for up to
       * fifteen minutes because the inbound watermark is still the newest
       * thing in the thread. Folding the log into the outbound watermark
       * flips the turn now and the sweep confirms it shortly after.
       *
       * Only outcomes that actually mean "I acted" count. 'held' and
       * 'skipped' rows are decisions to do nothing and must not read as a
       * reply.
       */
      supabase
        .from("outreach_log")
        .select("contact_id, created_at")
        .eq("user_id", userId)
        .in("status", ["sent", "done"])
        .in("contact_id", ids)
        .order("created_at", { ascending: false }),
      loadHandoffs(supabase, userId, ids),
    ]);

  // Newest first, so the first row seen for a contact is the latest action.
  const actedBy = new Map<string, string>();
  for (const row of actedRows ?? []) {
    if (!actedBy.has(row.contact_id)) actedBy.set(row.contact_id, row.created_at);
  }

  const cacheBy = new Map<string, TurnCache>();
  for (const id of ids) {
    const row = (cacheRows ?? []).find((r) => r.contact_id === id) ?? null;
    cacheBy.set(id, {
      last_inbound_at: row?.last_inbound_at ?? null,
      // Merged rather than passed separately so computeTurn keeps one notion
      // of "the last thing I did", whether it happened in Bonzo or here.
      last_outbound_at: newerOf(row?.last_outbound_at ?? null, actedBy.get(id) ?? null),
      last_message_at: row?.last_message_at ?? null,
      lead_state: (row?.lead_state as LeadState | null) ?? null,
    });
  }

  const tasksBy = new Map<string, { id: string; title: string; due_date: string | null; is_done: boolean }[]>();
  for (const t of taskRows ?? []) {
    const list = tasksBy.get(t.contact_id) ?? [];
    list.push({ id: t.id, title: t.title, due_date: t.due_date, is_done: t.is_done });
    tasksBy.set(t.contact_id, list);
  }

  const callsBy = new Map<string, { scheduled_at: string; status: string }[]>();
  for (const c of callRows ?? []) {
    const list = callsBy.get(c.contact_id) ?? [];
    list.push({ scheduled_at: c.scheduled_at, status: c.status });
    callsBy.set(c.contact_id, list);
  }

  const results: TurnResult[] = contacts.filter((c) => isTodayActive(c.stage)).map((contact) => {
    /*
     * A lead with no watermarks and no logged action has genuinely no
     * history, and computeTurn distinguishes that from "we know nothing yet"
     * only through a null cache. Collapsing an all-null row back to null
     * keeps that distinction rather than making every unswept lead look like
     * a synced one with an empty thread.
     */
    const merged = cacheBy.get(contact.id) ?? null;
    const cache =
      merged &&
      (merged.last_inbound_at || merged.last_outbound_at || merged.lead_state)
        ? merged
        : null;
    const verdict = computeTurn({
      contact,
      cache,
      tasks: tasksBy.get(contact.id) ?? [],
      calls: callsBy.get(contact.id) ?? [],
      /*
       * A handoff only holds a lead that is still in Quoted – Follow Up.
       * Moving a lead out of that stage is Eddie deciding to work it himself,
       * and "In a nurture campaign since Aug 14" would be a stale reason to
       * leave it sitting in Waiting once he has.
       */
      handoff:
        contact.stage === "quoted_follow_up" ? handoffs.get(contact.id) ?? null : null,
      now,
      timeZone,
      settings,
    });

    return { ...verdict, contact, leadState: cache?.lead_state ?? null };
  });

  return { ...groupToday(results), timeZone, settings };
}

/** The later of two instants, either of which may be unknown. */
function newerOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

/**
 * The most recent executed campaign handoff per contact.
 *
 * Keyed on the workflow's trigger rather than its name or its campaign id.
 * `no_inbound_since` is the handoff rule by construction — it is the rule that
 * fires on silence and moves a lead to a sequence that actually sends. The
 * park rule, which fires on entering the stage and moves a lead to a no-drip
 * campaign, deliberately does not count: parking exists so Eddie can work a
 * lead without Bonzo talking over him, and a parked lead is not one to stop
 * thinking about.
 */
async function loadHandoffs(
  supabase: SupabaseClient,
  userId: string,
  contactIds: string[]
): Promise<Map<string, TurnHandoff>> {
  const out = new Map<string, TurnHandoff>();

  const { data } = await supabase
    .from("workflow_runs")
    .select(
      "contact_id, fired_at, workflows!inner(user_id, trigger_type, action_type, action_config)"
    )
    .eq("status", "executed")
    .eq("workflows.user_id", userId)
    .eq("workflows.trigger_type", "no_inbound_since")
    .eq("workflows.action_type", "add_to_bonzo_campaign")
    .in("contact_id", contactIds)
    .order("fired_at", { ascending: false });

  for (const row of data ?? []) {
    // Ordered newest-first, so the first row seen for a contact is the one
    // that matters and later ones are earlier handoffs.
    if (out.has(row.contact_id)) continue;

    const wf = row.workflows as unknown as {
      action_config?: { campaign_name?: string | null } | null;
    };

    out.set(row.contact_id, {
      // Populated by the workflow settings page (section 6). Null falls back
      // to "a nurture campaign", which is vaguer than it should be but never
      // wrong — better than printing a campaign id at someone.
      campaign_name: wf?.action_config?.campaign_name ?? null,
      at: row.fired_at,
    });
  }

  return out;
}
