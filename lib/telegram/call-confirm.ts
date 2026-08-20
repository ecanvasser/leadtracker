/**
 * Confirming a detected call.
 *
 * A detected time is a guess until a human agrees with it. A misparsed time is
 * worse than no reminder — it produces confident wrong reminders and a missed
 * call — so this only ever asks.
 *
 * The card shows the exact words the time was read out of, both timezones, and
 * how the prospect's zone was determined, so the broker can judge how much to
 * trust it rather than taking it on faith.
 */

import { InlineKeyboard } from "grammy";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createBot } from "@/lib/telegram/bot";
import { getTelegramLink } from "@/lib/db/telegram";
import { escapeHtml, bonzoProspectUrl } from "@/lib/telegram/approval-card";
import { formatBothZones } from "@/lib/calls/timezone";
import { getUserTimezone } from "@/lib/time";
import type { TimezoneSource } from "@/lib/calls/timezone";

export const CALL_CB = {
  confirm: "cc",
  reject: "cx",
  outcomeDone: "cod",
  outcomeNoAnswer: "cona",
  outcomeReschedule: "cor",
} as const;

/** How much to trust the zone we inferred. */
const SOURCE_NOTE: Record<TimezoneSource, string> = {
  property_state: "from the property address",
  area_code: "from their area code — worth a sanity check",
  broker_default: "no location on file, so this assumes your timezone",
};

export function renderCallConfirmation(input: {
  contactName: string;
  scheduledAt: Date;
  prospectZone: string;
  brokerZone: string;
  timezoneSource: TimezoneSource;
  sourceQuote: string;
  phone: string | null;
  bonzoProspectId: number | null;
}): string {
  const lines: string[] = [
    `📞 <b>Call detected — ${escapeHtml(input.contactName)}</b>`,
    "",
    formatBothZones(input.scheduledAt, input.prospectZone, input.brokerZone),
    `<i>Timezone ${SOURCE_NOTE[input.timezoneSource]}.</i>`,
    "",
    `From their message:`,
    `<blockquote>${escapeHtml(input.sourceQuote)}</blockquote>`,
  ];

  if (input.phone) {
    // Plain text, never a tel: link. This app reminds; it does not dial.
    lines.push("", `Number: <code>${escapeHtml(input.phone)}</code>`);
  }

  lines.push("", "Confirm and I'll remind you 15 minutes before.");
  return lines.join("\n");
}

export function callConfirmKeyboard(
  callId: string,
  bonzoProspectId: number | null
): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("✅ Confirm", `${CALL_CB.confirm}:${callId}`)
    .text("✕ Not a call", `${CALL_CB.reject}:${callId}`);

  if (bonzoProspectId) {
    kb.row().url("Open in Bonzo", bonzoProspectUrl(bonzoProspectId));
  }
  return kb;
}

/** Asks the broker to confirm a detected call. */
export async function pushCallConfirmation(
  supabase: SupabaseClient,
  userId: string,
  callId: string
): Promise<boolean> {
  const link = await getTelegramLink(supabase, userId);
  if (!link) return false;

  const { data: call } = await supabase
    .from("scheduled_calls")
    .select("id, contact_id, scheduled_at, prospect_timezone, timezone_source, source_quote, status")
    .eq("id", callId)
    .maybeSingle();

  if (!call || call.status !== "proposed") return false;

  const { data: contact } = await supabase
    .from("contacts")
    .select("name, phone, bonzo_prospect_id")
    .eq("id", call.contact_id)
    .maybeSingle();

  if (!contact) return false;

  const brokerZone = await getUserTimezone(userId, supabase);
  const bot = createBot();

  await bot.api.sendMessage(
    link.telegram_user_id,
    renderCallConfirmation({
      contactName: contact.name,
      scheduledAt: new Date(call.scheduled_at),
      prospectZone: call.prospect_timezone,
      brokerZone,
      timezoneSource: call.timezone_source as TimezoneSource,
      sourceQuote: call.source_quote,
      phone: contact.phone,
      bonzoProspectId: contact.bonzo_prospect_id,
    }),
    {
      parse_mode: "HTML",
      reply_markup: callConfirmKeyboard(callId, contact.bonzo_prospect_id),
    }
  );

  return true;
}

/** Keyboard for the post-call outcome prompt. */
export function callOutcomeKeyboard(callId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Completed", `${CALL_CB.outcomeDone}:${callId}`)
    .text("📵 No answer", `${CALL_CB.outcomeNoAnswer}:${callId}`)
    .row()
    .text("🔁 Reschedule", `${CALL_CB.outcomeReschedule}:${callId}`);
}

/**
 * Applies a confirm/reject/outcome decision.
 *
 * Returns the line to show back, or null when the callback is not one of
 * these.
 */
export async function handleCallCallback(
  supabase: SupabaseClient,
  userId: string,
  data: string
): Promise<string | null> {
  const [code, callId] = data.split(":");
  if (!callId) return null;

  const { data: call } = await supabase
    .from("scheduled_calls")
    .select("id, contact_id, scheduled_at, prospect_timezone, status")
    .eq("id", callId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!call) return null;

  switch (code) {
    case CALL_CB.confirm: {
      if (call.status === "confirmed") return "Already confirmed.";
      await supabase
        .from("scheduled_calls")
        .update({ status: "confirmed" })
        .eq("id", callId);
      const brokerZone = await getUserTimezone(userId, supabase);
      return `✅ Confirmed — ${formatBothZones(
        new Date(call.scheduled_at),
        call.prospect_timezone,
        brokerZone
      )}. Reminders at 15 minutes before and at the time.`;
    }

    case CALL_CB.reject:
      await supabase
        .from("scheduled_calls")
        .update({ status: "cancelled" })
        .eq("id", callId);
      return "✕ Discarded — no reminder will be set.";

    case CALL_CB.outcomeDone:
      await supabase
        .from("scheduled_calls")
        .update({ status: "completed" })
        .eq("id", callId);
      await logCallOutcome(supabase, userId, call.contact_id, "completed");
      return "✅ Logged as completed.";

    case CALL_CB.outcomeNoAnswer:
      await supabase
        .from("scheduled_calls")
        .update({ status: "missed" })
        .eq("id", callId);
      await logCallOutcome(supabase, userId, call.contact_id, "no_answer");
      return "📵 Logged as no answer. They'll come back into the queue.";

    case CALL_CB.outcomeReschedule:
      await supabase
        .from("scheduled_calls")
        .update({ status: "rescheduled" })
        .eq("id", callId);
      await logCallOutcome(supabase, userId, call.contact_id, "reschedule");
      return "🔁 Marked for rescheduling. They're back in the queue.";

    default:
      return null;
  }
}

/**
 * Records the outcome so cadence and lead state see it.
 *
 * A call that happened is a touch; one that went unanswered is a signal about
 * responsiveness. Both belong in outreach_log rather than only on the call row.
 */
async function logCallOutcome(
  supabase: SupabaseClient,
  userId: string,
  contactId: string,
  outcome: "completed" | "no_answer" | "reschedule"
): Promise<void> {
  await supabase.from("outreach_log").insert({
    user_id: userId,
    contact_id: contactId,
    action_type: "call",
    status: outcome === "completed" ? "sent" : outcome,
    draft_message: `Scheduled call — ${outcome.replace("_", " ")}`,
  });
}

export function isCallCallback(data: string): boolean {
  const code = data.split(":")[0];
  return (Object.values(CALL_CB) as string[]).includes(code);
}
