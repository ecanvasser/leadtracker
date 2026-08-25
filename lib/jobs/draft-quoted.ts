/**
 * draft_quoted — the only job in the app that spends money on prose.
 *
 * Phase 8 section 6A. It drafts one message for one lead inside the quoted
 * window, stores it as a daily_queue row, and pushes the approval card. It
 * never sends: Send is a button Eddie presses, and in dry run the card does
 * not even carry one.
 *
 * Three gates stand in front of the model call, checked in this order, and
 * none of them is optional:
 *
 *   1. drafting_mode — 'off' means no job is enqueued and this returns
 *      immediately if one somehow exists.
 *   2. draftDue — scope, the schedule, and D5's two hard constraints.
 *   3. The daily token budget, which every model path in the app respects.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { draftOne } from "@/lib/ai/draft-one";
import { draftDue } from "@/lib/ai/draft-schedule";
import {
  getCommunicationHistory,
  getMortgageFields,
  getProspect,
  isInbound,
  isOptedOut,
  isOutbound,
  messagesOnly,
  type BonzoCommunication,
  type BonzoProspect,
} from "@/lib/bonzo/client";
import type { LeadState } from "@/lib/insights/lead-state";
// Type-only, so this does not create a runtime cycle with handlers.ts, which
// imports the handler below.
import type { JobHandler } from "@/lib/jobs/handlers";
import { localDate } from "@/lib/time";
import { recordModelUsage, withinBudget } from "@/lib/ai/usage";
import type { AllStages } from "@/types/db";

/** Marks the queue rows this job creates, so it can find its own work. */
export const QUOTED_DRAFT_REASON = "Quoted-window draft";

/** Logged for every generated draft, so the caps can count them. */
export const DRAFT_GENERATED_ACTION = "draft_generated";

export interface DraftSettings {
  mode: "off" | "dry_run" | "live";
  scheduleHours: number[];
  maxRedraftsPerDay: number;
  /** Hours of quiet required before a draft is due. See draft-schedule.ts. */
  minHoursSinceLastMessage: number;
  brokerName: string;
  brokerCompany: string;
  timeZone: string;
}

export async function readDraftSettings(
  supabase: SupabaseClient,
  userId: string
): Promise<DraftSettings> {
  const { data } = await supabase
    .from("user_settings")
    .select(
      "drafting_mode, draft_schedule_hours, max_redrafts_per_day, min_hours_since_last_message, broker_display_name, broker_company, timezone"
    )
    .eq("user_id", userId)
    .maybeSingle();

  return {
    // Absent settings mean off. A missing row must never be read as
    // permission to draft.
    mode: (data?.drafting_mode as DraftSettings["mode"]) ?? "off",
    scheduleHours: data?.draft_schedule_hours ?? [],
    maxRedraftsPerDay: data?.max_redrafts_per_day ?? 0,
    // Six hours if the column is somehow absent. Erring toward quiet: the
    // failure of too high is a late touch, of too low a draft on top of a
    // conversation Eddie is already having.
    minHoursSinceLastMessage: data?.min_hours_since_last_message ?? 6,
    brokerName: data?.broker_display_name ?? "",
    brokerCompany: data?.broker_company ?? "",
    timeZone: data?.timezone ?? "America/Los_Angeles",
  };
}

/**
 * The far edge of the drafting window, in days.
 *
 * This used to be the handoff threshold, and the two were the same boundary
 * seen from two sides. Since leads are enrolled in "Responded (NEW Quoted)"
 * on arrival rather than handed off later, the boundary that actually matters
 * is different: it is how long that campaign waits before its first touch —
 * two days — because after that, Bonzo is talking to the lead and a personal
 * draft would be the second uncoordinated voice.
 *
 * Still read from the handoff workflow's `days`, which is now the only place
 * that number is written down and is editable on the rules page. That is a
 * proxy rather than the real source, and the real source is a Bonzo campaign
 * setting this app cannot read. Worth promoting to its own setting if the
 * campaign's delay ever changes; harmless while both are two.
 */
export async function windowDaysFor(
  supabase: SupabaseClient,
  userId: string
): Promise<number> {
  const { data } = await supabase
    .from("workflows")
    .select("trigger_config")
    .eq("user_id", userId)
    .eq("trigger_type", "no_inbound_since")
    .eq("action_type", "add_to_bonzo_campaign")
    .maybeSingle();

  const days = (data?.trigger_config as { days?: number } | null)?.days;
  return typeof days === "number" && days > 0 ? days : 2;
}

export const draftQuoted: JobHandler = async (supabase, job) => {
  const contactId = job.contact_id;
  if (!contactId) throw new Error("draft_quoted requires a contact_id");

  const { data: contact } = await supabase
    .from("contacts")
    .select(
      "id, user_id, name, stage, stage_changed_at, insights_enabled, bonzo_prospect_id"
    )
    .eq("id", contactId)
    .maybeSingle();

  if (!contact) return { summary: "contact gone", usedModel: false };

  const settings = await readDraftSettings(supabase, contact.user_id);
  if (settings.mode === "off") {
    return { summary: "drafting is off", usedModel: false };
  }

  const { data: cache } = await supabase
    .from("insights_cache")
    .select(
      "lead_state, last_inbound_at, last_message_at, bonzo_communication, bonzo_prospect_data"
    )
    .eq("contact_id", contactId)
    .maybeSingle();

  const timeZone = settings.timeZone;
  const today = localDate(new Date(), timeZone);

  // Drafts already generated for this lead, and whether one is still pending.
  const [{ data: generated }, { data: pending }] = await Promise.all([
    supabase
      .from("outreach_log")
      .select("created_at")
      .eq("contact_id", contactId)
      .eq("action_type", DRAFT_GENERATED_ACTION)
      .order("created_at", { ascending: false }),
    // Today's only, for the same reason as the agent path: a pending row from
    // a previous day is not on the phone and not on /daily, so it is not
    // waiting on a decision and must not block a new draft forever.
    supabase
      .from("daily_queue")
      .select("id")
      .eq("contact_id", contactId)
      .eq("priority_reason", QUOTED_DRAFT_REASON)
      .eq("status", "pending")
      .eq("queue_date", today)
      .limit(1),
  ]);

  const due = draftDue({
    stage: contact.stage as AllStages,
    stageChangedAt: contact.stage_changed_at,
    windowDays: await windowDaysFor(supabase, contact.user_id),
    scheduleHours: settings.scheduleHours,
    lastInboundAt: cache?.last_inbound_at ?? null,
    lastMessageAt: cache?.last_message_at ?? null,
    minHoursSinceLastMessage: settings.minHoursSinceLastMessage,
    draftsGenerated: (generated ?? []).map((r) => r.created_at as string),
    hasPendingDraft: (pending ?? []).length > 0,
    now: new Date(),
    timeZone,
  });

  if (!due.due) {
    return { summary: `no draft due: ${due.reason}`, usedModel: false };
  }

  /*
   * Re-read Bonzo before drafting, and re-decide on what comes back.
   *
   * Everything above this point came from insights_cache, which the refresh
   * sweep updates every fifteen minutes. That is fine for deciding whether a
   * lead is worth looking at, and not fine for deciding to write to them. A
   * lead who replied four minutes ago still looks silent in the cache, and the
   * draft would land on top of a live conversation — the uncoordinated second
   * touch this whole phase exists to avoid.
   *
   * Placed after the due check rather than before it so the extra API call is
   * only spent on a lead we were about to spend a model call on anyway. One
   * request, a handful of times a day.
   *
   * The fresh watermarks are written back, so a draft cancelled here also
   * corrects the cache instead of letting the next tick repeat the same work.
   */
  let communications = (cache?.bonzo_communication ?? []) as BonzoCommunication[];
  let prospect = (cache?.bonzo_prospect_data as BonzoProspect | null) ?? null;

  if (contact.bonzo_prospect_id) {
    try {
      const [fresh, freshProspect] = await Promise.all([
        getCommunicationHistory(contact.bonzo_prospect_id),
        getProspect(contact.bonzo_prospect_id),
      ]);
      communications = fresh;
      prospect = freshProspect ?? prospect;

      const messages = messagesOnly(fresh);
      const newest = (match: (d: string) => boolean): string | null => {
        const times = messages
          .filter((c) => match(c.direction))
          .map((c) => new Date(c.created_at).getTime())
          .filter((t) => Number.isFinite(t));
        return times.length ? new Date(Math.max(...times)).toISOString() : null;
      };
      const freshInbound = newest(isInbound);
      const freshOutbound = newest(isOutbound);
      const freshLatest =
        [freshInbound, freshOutbound]
          .filter((v): v is string => v !== null)
          .sort()
          .at(-1) ?? null;

      await supabase
        .from("insights_cache")
        .update({
          bonzo_communication: fresh,
          last_message_at: freshLatest,
          last_inbound_at: freshInbound,
          last_outbound_at: freshOutbound,
          last_synced_at: new Date().toISOString(),
        })
        .eq("contact_id", contactId);

      const recheck = draftDue({
        stage: contact.stage as AllStages,
        stageChangedAt: contact.stage_changed_at,
        windowDays: await windowDaysFor(supabase, contact.user_id),
        scheduleHours: settings.scheduleHours,
        lastInboundAt: freshInbound,
        lastMessageAt: freshLatest,
        minHoursSinceLastMessage: settings.minHoursSinceLastMessage,
        draftsGenerated: (generated ?? []).map((r) => r.created_at as string),
        hasPendingDraft: (pending ?? []).length > 0,
        now: new Date(),
        timeZone,
      });

      if (!recheck.due) {
        return {
          summary: `no draft due after fresh read: ${recheck.reason}`,
          usedModel: false,
        };
      }
    } catch (e) {
      /*
       * A failed re-read is not a reason to draft from stale data. Bonzo being
       * unavailable is exactly when the cache is least trustworthy, and the
       * job retries.
       */
      throw e instanceof Error
        ? e
        : new Error("Bonzo re-read failed before drafting");
    }
  }

  /*
   * An opt-out bars a draft as surely as it bars a send.
   *
   * Checked before the model call rather than at Send: a draft that can never
   * go out is a card Eddie has to read and dismiss, plus tokens spent on a
   * message with no recipient.
   */
  if (
    prospect &&
    (isOptedOut(prospect, "sms") ||
      isOptedOut(prospect, "email") ||
      prospect.do_not_call === true)
  ) {
    return { summary: "prospect is opted out; no draft", usedModel: false };
  }

  /*
   * No loan file means no numbers, and a draft in this window without the
   * numbers is the exact failure 6A.1 describes about the retired system —
   * writing from almost nothing and filling the vacuum with enthusiasm. The
   * validator would catch an invented figure, but not the blandness that
   * comes from having nothing to say.
   */
  if (getMortgageFields(prospect) === null) {
    return { summary: "no loan file; refusing to draft from nothing", usedModel: false };
  }

  /*
   * Cost rule C6. Drafting is the one path in Phase 8 that spends money, so it
   * is the first thing that should stop when the day's budget is gone.
   * Checked after the fresh read so the cache still gets corrected, and before
   * the model so nothing is charged.
   */
  const budget = await withinBudget(supabase, contact.user_id);
  if (!budget.ok) {
    return { summary: "over daily token budget; no draft", usedModel: false };
  }

  const hoursSincePitch = contact.stage_changed_at
    ? (Date.now() - new Date(contact.stage_changed_at).getTime()) / 3_600_000
    : null;

  const result = await draftOne({
    channel: "sms",
    contactName: contact.name,
    brokerName: settings.brokerName,
    brokerCompany: settings.brokerCompany,
    prospect,
    communications,
    leadState: (cache?.lead_state as LeadState | null) ?? null,
    hoursSincePitch,
  });

  /*
   * One ledger row per attempt, not per draft. draftOne retries once on a
   * validation failure, and both calls were charged — a budget that counted
   * only the surviving draft would understate the cost of exactly the leads
   * that are hardest to write for.
   */
  for (const usage of result.usage) {
    await recordModelUsage(
      supabase,
      { userId: contact.user_id, purpose: "draft_quoted", contactId },
      usage
    );
  }

  // Recorded whether or not it validated: the caps count attempts, not
  // successes, and a draft that failed twice still cost two calls.
  await supabase.from("outreach_log").insert({
    user_id: contact.user_id,
    contact_id: contactId,
    action_type: DRAFT_GENERATED_ACTION,
    status: result.validated ? "drafted" : "drafted_unvalidated",
    draft_message: result.body,
  });

  const { data: queued, error: queueErr } = await supabase
    .from("daily_queue")
    .insert({
      user_id: contact.user_id,
      contact_id: contactId,
      queue_date: today,
      priority_rank: 1,
      priority_reason: QUOTED_DRAFT_REASON,
      action_type: "sms",
      draft_message: result.body,
      status: "pending",
      unvalidated_reasons: result.validated
        ? null
        : result.violations.map((v) => v.detail),
    })
    .select("id")
    .single();

  if (queueErr) throw queueErr;

  /*
   * Dry run pushes too, as a read-only card.
   *
   * This used to stop here on the reasoning that a card with no Send button
   * is a notification Eddie cannot act on. That was wrong twice over. The
   * point of dry run is to judge whether the drafts sound like him, and he
   * cannot judge what he never sees — Telegram is where he actually reads
   * things, and a row on /daily requires him to be at a desk and remember to
   * look. The rest of the code already assumed this: buildCardInput sets
   * readOnly whenever drafting is not live, and the keyboard renders that as
   * Dismiss with no Send and no Edit. The card was built and nothing sent it.
   */
  const { pushCard } = await import("@/lib/telegram/push");
  const push = await pushCard(supabase, contact.user_id, queued.id);

  return {
    summary:
      `drafted for ${contact.name}` +
      (settings.mode === "dry_run" ? " (dry run)" : "") +
      (result.validated ? "" : ` — unvalidated: ${result.violations.length} issues`) +
      (push.pushed ? "; pushed" : `; not pushed (${push.reason})`),
    usedModel: true,
  };
};

/** Whether the lead has replied since the quote — used by the enqueue sweep. */
export function hasRepliedSincePitch(
  communications: BonzoCommunication[],
  pitchedAt: string | null
): boolean {
  if (!pitchedAt) return false;
  const pitch = new Date(pitchedAt).getTime();
  return communications.some(
    (c) => isInbound(c.direction) && new Date(c.created_at).getTime() > pitch
  );
}
