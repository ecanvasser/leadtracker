/**
 * Scanning a refreshed history for call commitments.
 *
 * Runs during cache refresh, over new messages only. Detected calls land as
 * `proposed` and go to Telegram for confirmation — nothing here schedules a
 * reminder on its own.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  candidateToInstant,
  detectCallInThread,
  type CallCandidate,
} from "@/lib/calls/detect";
import {
  resolveProspectTimezone,
  type ResolvedTimezone,
} from "@/lib/calls/timezone";
import { getMortgageFields } from "@/lib/bonzo/client";
import { localDate } from "@/lib/time";

export interface ScanInput {
  userId: string;
  contactId: string;
  prospect: Record<string, unknown> | null;
  communications: {
    id?: number | string;
    content: string | null;
    direction: string;
    created_at: string;
  }[];
  /** Only messages newer than this are read. */
  scannedThrough: string | null;
  brokerTimezone: string;
  phone: string | null;
  /**
   * Called with what each model call cost. Optional so the pattern-only paths
   * and the tests stay unchanged; the worker passes it, because a call this
   * function makes is spend the budget has to see.
   */
  onUsage?: (usage: {
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    latency_ms: number;
  }) => void;
}

export interface ScanResult {
  /** The call that was proposed, if any. */
  proposed: {
    scheduledAt: Date;
    zone: ResolvedTimezone;
    candidate: CallCandidate;
  } | null;
  /**
   * A lead who asked to talk without naming a time.
   *
   * "Let's talk in the morning. What time are you available?" is a request for
   * a call with nothing to extract — the detector correctly finds no time, and
   * before this the whole exchange produced silence, indistinguishable from a
   * thread with no call in it at all. That is the case most likely to be
   * forgotten, because the lead is actively waiting.
   *
   * Inbound only. Eddie writing "let's talk tomorrow" is him making a plan,
   * not a lead asking him for one.
   */
  wantsCall: { quote: string; at: string } | null;
  messagesScanned: number;
  modelCalls: number;
}

/**
 * Reads new messages and proposes at most one call.
 *
 * Newest-first, stopping at the first hit: if a thread renegotiated the time
 * three times, the last word is the one that counts.
 */
export async function scanForCallCommitments(
  input: ScanInput
): Promise<ScanResult> {
  const since = input.scannedThrough ? new Date(input.scannedThrough).getTime() : 0;

  const fresh = input.communications
    .filter((c) => {
      const t = new Date(c.created_at).getTime();
      return Number.isFinite(t) && t > since && (c.content ?? "").trim();
    })
    .sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

  if (fresh.length === 0) {
    return { proposed: null, wantsCall: null, messagesScanned: 0, modelCalls: 0 };
  }

  const mf = getMortgageFields(input.prospect);
  const zone = resolveProspectTimezone({
    propertyAddress: mf?.property_address ?? null,
    phone: input.phone,
    brokerTimezone: input.brokerTimezone,
  });

  /*
   * One call over the whole thread, not one per message.
   *
   * The per-message detector asked "does this sentence contain a commitment?",
   * which cannot see the shape a booking actually takes here:
   *
   *   BROKER: When is a good time to call?
   *   LEAD:   5pm
   *
   * Neither message is a commitment on its own. Every refinement to the
   * single-message gate — more phrases, wider patterns — made it either miss
   * this or start firing on "I get paid on the 15th". Reading the exchange is
   * the only thing that answers the question being asked.
   *
   * The whole thread goes rather than only the new messages: "5pm" means
   * nothing without the question above it, and the question may be older than
   * the watermark. The watermark still decides *whether* to spend anything at
   * all, which is what the cost rule is about.
   */
  const detection = await detectCallInThread(
    input.communications,
    localDate(new Date(), zone.timeZone),
    zone.timeZone
  );

  if (detection.usage) input.onUsage?.(detection.usage);
  const modelCalls = detection.usage ? 1 : 0;

  if (detection.call) {
    const scheduledAt = candidateToInstant(
      {
        date: detection.call.date,
        hour: detection.call.hour,
        minute: detection.call.minute,
        quote: detection.call.quote,
        method: "model",
      },
      zone.timeZone
    );

    // A time already gone is a stale reference, not a booking.
    if (scheduledAt.getTime() > Date.now()) {
      return {
        proposed: {
          scheduledAt,
          zone,
          candidate: {
            date: detection.call.date,
            hour: detection.call.hour,
            minute: detection.call.minute,
            quote: detection.call.quote,
            method: "model",
          },
        },
        wantsCall: null,
        messagesScanned: fresh.length,
        modelCalls,
      };
    }
  }

  return {
    proposed: null,
    wantsCall: detection.wantsCall
      ? {
          quote: detection.wantsCall.quote.slice(0, 300),
          // Anchored to the newest message, since the request is a property of
          // the conversation as a whole rather than of one line in it.
          at: fresh[0]?.created_at ?? new Date().toISOString(),
        }
      : null,
    messagesScanned: fresh.length,
    modelCalls,
  };
}

/**
 * Records a proposed call.
 *
 * Returns the row id when a new proposal was stored, or null when an
 * equivalent one already exists. Idempotent by design: refresh runs every 15
 * minutes and must not stack duplicate proposals for the same commitment.
 */
export async function recordProposedCall(
  supabase: SupabaseClient,
  input: {
    userId: string;
    contactId: string;
    scheduledAt: Date;
    zone: ResolvedTimezone;
    candidate: CallCandidate;
    sourceMessageId?: string | null;
  }
): Promise<string | null> {
  const { data: existing } = await supabase
    .from("scheduled_calls")
    .select("id, scheduled_at, status")
    .eq("contact_id", input.contactId)
    .in("status", ["proposed", "confirmed"])
    .maybeSingle();

  if (existing) {
    const sameTime =
      Math.abs(
        new Date(existing.scheduled_at).getTime() - input.scheduledAt.getTime()
      ) < 60_000;

    // Same call, already known.
    if (sameTime) return null;

    // A confirmed call is not silently moved by a later message. The broker
    // confirmed that time; a change needs his say-so.
    if (existing.status === "confirmed") return null;

    // An unconfirmed proposal is superseded by the newer commitment.
    await supabase
      .from("scheduled_calls")
      .update({
        scheduled_at: input.scheduledAt.toISOString(),
        prospect_timezone: input.zone.timeZone,
        timezone_source: input.zone.source,
        source_quote: input.candidate.quote,
        source_message_id: input.sourceMessageId ?? null,
      })
      .eq("id", existing.id);

    return existing.id;
  }

  const { data, error } = await supabase
    .from("scheduled_calls")
    .insert({
      user_id: input.userId,
      contact_id: input.contactId,
      scheduled_at: input.scheduledAt.toISOString(),
      prospect_timezone: input.zone.timeZone,
      timezone_source: input.zone.source,
      source_quote: input.candidate.quote,
      source_message_id: input.sourceMessageId ?? null,
      status: "proposed",
    })
    .select("id")
    .single();

  if (error) {
    // The partial unique index can still reject under a race; not an error
    // worth failing the refresh over.
    if (error.code === "23505") return null;
    throw error;
  }

  return data.id;
}

/**
 * Whether a contact has a confirmed call close enough to suppress outreach.
 *
 * Texting someone an hour before a scheduled call is the kind of thing that
 * makes an assistant feel automated. Suppression runs from well before the
 * call until the window has clearly passed.
 */
export async function hasImminentCall(
  supabase: SupabaseClient,
  contactId: string,
  now: Date = new Date()
): Promise<boolean> {
  const from = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
  const to = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  const { count } = await supabase
    .from("scheduled_calls")
    .select("id", { count: "exact", head: true })
    .eq("contact_id", contactId)
    .eq("status", "confirmed")
    .gte("scheduled_at", from)
    .lte("scheduled_at", to);

  return (count ?? 0) > 0;
}
