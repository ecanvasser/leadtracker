/**
 * Booking a call by hand, and reading back the day's calls.
 *
 * The detector covers the common case — a lead writes "call me at noon
 * tomorrow" and the scanner finds it. This covers the rest: a call agreed on
 * the phone, one Eddie decides to make himself, or a detected time he wants to
 * correct.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveProspectTimezone,
  type ResolvedTimezone,
} from "@/lib/calls/timezone";
import { getMortgageFields, type BonzoProspect } from "@/lib/bonzo/client";
import { endOfLocalDayUtc, localDate, startOfLocalDayUtc } from "@/lib/time";

export interface BookCallInput {
  userId: string;
  contactId: string;
  /** The instant of the call, already resolved from local wall-clock input. */
  scheduledAt: Date;
  /** Eddie's own reason, shown on the reminder. */
  note?: string | null;
  brokerTimezone: string;
  /** Replace an existing live call rather than refusing. */
  replace?: boolean;
}

export interface BookCallResult {
  ok: boolean;
  callId?: string;
  error?: string;
  zone?: ResolvedTimezone;
}

/**
 * Books a call and confirms it in the same step.
 *
 * Unlike a detected call, this needs no confirmation card. A detected time is
 * a reading of someone's words and can be wrong in a way that has Eddie
 * ringing a stranger at 7am; a time he typed is already true. Asking him to
 * confirm what he just entered is the kind of ceremony that teaches people to
 * tap through prompts without reading them.
 */
export async function bookCall(
  supabase: SupabaseClient,
  input: BookCallInput
): Promise<BookCallResult> {
  if (!Number.isFinite(input.scheduledAt.getTime())) {
    return { ok: false, error: "That time could not be read." };
  }
  if (input.scheduledAt.getTime() < Date.now()) {
    // A reminder for a moment that has passed cannot fire, so it would sit in
    // the list looking scheduled forever.
    return { ok: false, error: "That time is in the past." };
  }

  const { data: contact } = await supabase
    .from("contacts")
    .select("id, user_id, name, phone")
    .eq("id", input.contactId)
    .maybeSingle();

  if (!contact) return { ok: false, error: "Contact not found." };

  const { data: cache } = await supabase
    .from("insights_cache")
    .select("bonzo_prospect_data")
    .eq("contact_id", input.contactId)
    .maybeSingle();

  const mf = getMortgageFields(
    (cache?.bonzo_prospect_data as BonzoProspect | null) ?? null
  );

  // The lead's zone, not Eddie's. A reminder that cannot say what time it is
  // where they are is a reminder that gets someone called at breakfast.
  const zone = resolveProspectTimezone({
    propertyAddress: mf?.property_address ?? null,
    phone: contact.phone ?? null,
    brokerTimezone: input.brokerTimezone,
  });

  const { data: existing } = await supabase
    .from("scheduled_calls")
    .select("id")
    .eq("contact_id", input.contactId)
    .in("status", ["proposed", "confirmed"])
    .maybeSingle();

  if (existing && !input.replace) {
    return {
      ok: false,
      error: "This lead already has a call booked. Cancel it first, or replace it.",
    };
  }

  if (existing) {
    await supabase
      .from("scheduled_calls")
      .update({ status: "rescheduled" })
      .eq("id", existing.id);
  }

  const { data: created, error } = await supabase
    .from("scheduled_calls")
    .insert({
      user_id: input.userId,
      contact_id: input.contactId,
      scheduled_at: input.scheduledAt.toISOString(),
      prospect_timezone: zone.timeZone,
      timezone_source: zone.source,
      source: "manual",
      // No quote: nothing was said, Eddie decided. The note carries the why.
      source_quote: null,
      note: input.note?.trim() || null,
      // Confirmed on arrival — see the doc comment.
      status: "confirmed",
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: error.message };

  return { ok: true, callId: created.id, zone };
}

export interface DayCall {
  id: string;
  contact_id: string;
  contact_name: string;
  phone: string | null;
  scheduled_at: string;
  prospect_timezone: string;
  timezone_source: string;
  status: string;
  source: string;
  source_quote: string | null;
  note: string | null;
  bonzo_prospect_id: number | null;
}

/**
 * Every call in one local day, soonest first.
 *
 * Includes `proposed` as well as `confirmed`. An unconfirmed call is still
 * something Eddie needs to see today — arguably more urgently, since it is
 * waiting on him to say whether it is real.
 */
export async function callsForDay(
  supabase: SupabaseClient,
  userId: string,
  timeZone: string,
  day: string = localDate(new Date(), timeZone)
): Promise<DayCall[]> {
  const { data } = await supabase
    .from("scheduled_calls")
    .select(
      "id, contact_id, scheduled_at, prospect_timezone, timezone_source, status, source, source_quote, note, contacts(name, phone, bonzo_prospect_id)"
    )
    .eq("user_id", userId)
    .in("status", ["proposed", "confirmed"])
    .gte("scheduled_at", startOfLocalDayUtc(day, timeZone).toISOString())
    .lt("scheduled_at", endOfLocalDayUtc(day, timeZone).toISOString())
    .order("scheduled_at", { ascending: true });

  return (data ?? []).map((r) => {
    const c = r.contacts as unknown as {
      name: string;
      phone: string | null;
      bonzo_prospect_id: number | null;
    } | null;
    return {
      id: r.id as string,
      contact_id: r.contact_id as string,
      contact_name: c?.name ?? "Unknown",
      phone: c?.phone ?? null,
      scheduled_at: r.scheduled_at as string,
      prospect_timezone: r.prospect_timezone as string,
      timezone_source: r.timezone_source as string,
      status: r.status as string,
      source: (r.source as string) ?? "detected",
      source_quote: (r.source_quote as string | null) ?? null,
      note: (r.note as string | null) ?? null,
      bonzo_prospect_id: c?.bonzo_prospect_id ?? null,
    };
  });
}

/**
 * Calls that have come and gone without an outcome being recorded.
 *
 * Surfaced so a call Eddie missed does not simply vanish from the list at
 * midnight. Bounded to the last two days: past that it is history, not a
 * prompt.
 */
export async function overdueCalls(
  supabase: SupabaseClient,
  userId: string,
  now: Date = new Date()
): Promise<DayCall[]> {
  const { data } = await supabase
    .from("scheduled_calls")
    .select(
      "id, contact_id, scheduled_at, prospect_timezone, timezone_source, status, source, source_quote, note, contacts(name, phone, bonzo_prospect_id)"
    )
    .eq("user_id", userId)
    .eq("status", "confirmed")
    .lt("scheduled_at", new Date(now.getTime() - 30 * 60_000).toISOString())
    .gte("scheduled_at", new Date(now.getTime() - 2 * 86_400_000).toISOString())
    .order("scheduled_at", { ascending: true });

  return (data ?? []).map((r) => {
    const c = r.contacts as unknown as {
      name: string;
      phone: string | null;
      bonzo_prospect_id: number | null;
    } | null;
    return {
      id: r.id as string,
      contact_id: r.contact_id as string,
      contact_name: c?.name ?? "Unknown",
      phone: c?.phone ?? null,
      scheduled_at: r.scheduled_at as string,
      prospect_timezone: r.prospect_timezone as string,
      timezone_source: r.timezone_source as string,
      status: r.status as string,
      source: (r.source as string) ?? "detected",
      source_quote: (r.source_quote as string | null) ?? null,
      note: (r.note as string | null) ?? null,
      bonzo_prospect_id: c?.bonzo_prospect_id ?? null,
    };
  });
}

export interface WantsCall {
  contact_id: string;
  contact_name: string;
  loan_type: string;
  asked_at: string;
  quote: string;
  bonzo_prospect_id: number | null;
}

/**
 * Leads who asked to talk and never named a time.
 *
 * The gap the time-extracting detector cannot see. Excludes anyone with a call
 * already on the books — they asked, it got booked, the request is answered —
 * and anyone Eddie has dismissed, until they ask again.
 */
export async function wantsCallLeads(
  supabase: SupabaseClient,
  userId: string
): Promise<WantsCall[]> {
  const { data } = await supabase
    .from("insights_cache")
    .select(
      "contact_id, wants_call_at, wants_call_quote, contacts(name, loan_type, stage, bonzo_prospect_id)"
    )
    .eq("user_id", userId)
    .not("wants_call_at", "is", null)
    .is("wants_call_dismissed_at", null)
    .order("wants_call_at", { ascending: false })
    .limit(20);

  const rows = (data ?? []).filter((r) => {
    const c = r.contacts as unknown as { stage?: string } | null;
    // A dead or funded lead is not waiting on a call.
    return c?.stage !== "adverse" && c?.stage !== "funded";
  });

  if (rows.length === 0) return [];

  // Anyone with a live call already has their answer.
  const { data: booked } = await supabase
    .from("scheduled_calls")
    .select("contact_id")
    .eq("user_id", userId)
    .in("status", ["proposed", "confirmed"]);

  const hasCall = new Set((booked ?? []).map((b) => b.contact_id as string));

  return rows
    .filter((r) => !hasCall.has(r.contact_id as string))
    .map((r) => {
      const c = r.contacts as unknown as {
        name: string;
        loan_type: string;
        bonzo_prospect_id: number | null;
      } | null;
      return {
        contact_id: r.contact_id as string,
        contact_name: c?.name ?? "Unknown",
        loan_type: c?.loan_type ?? "",
        asked_at: r.wants_call_at as string,
        quote: (r.wants_call_quote as string) ?? "",
        bonzo_prospect_id: c?.bonzo_prospect_id ?? null,
      };
    });
}
