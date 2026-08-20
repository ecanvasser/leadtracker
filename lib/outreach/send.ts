/**
 * Sending an approved queue item through Bonzo.
 *
 * One implementation for both surfaces. Telegram approval and the web queue
 * must behave identically — same opt-out checks, same idempotency, same
 * logging — and two copies of this would drift within a week.
 *
 * The ordering rule throughout: a queue item is marked sent only after Bonzo
 * confirms it. Marking first and sending after would leave a lead silently
 * un-contacted with a green checkmark next to their name.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  sendSms,
  sendEmail,
  getProspect,
  isOptedOut,
  BonzoRateLimitError,
  BonzoRequestError,
  BonzoSendRejectedError,
  type BonzoSendResult,
} from "@/lib/bonzo/client";

export interface SendOutcome {
  status: "sent" | "already_sent" | "skipped";
  /** Bonzo's message id, when a send actually happened. */
  providerMessageId: string | null;
  channel: "sms" | "email";
  body: string;
  subject: string | null;
  /** Human-readable line for the Telegram receipt. */
  receipt: string;
}

/** Raised for conditions the broker should see rather than a stack trace. */
export class SendRefusedError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "SendRefusedError";
    this.reason = reason;
  }
}

export interface SendQueueItemOptions {
  /** Replaces the drafted body — the Telegram Edit flow and web edit path. */
  overrideBody?: string;
  overrideSubject?: string;
}

/**
 * Sends one queue item.
 *
 * Idempotent by design: Telegram retries webhooks, and a double-delivered
 * callback must not send a prospect the same message twice. An item that is
 * already sent returns its recorded outcome instead of sending again.
 */
export async function sendQueueItem(
  supabase: SupabaseClient,
  userId: string,
  queueItemId: string,
  options: SendQueueItemOptions = {}
): Promise<SendOutcome> {
  const { data: item, error } = await supabase
    .from("daily_queue")
    .select(
      "id, user_id, contact_id, action_type, draft_message, email_subject, status"
    )
    .eq("id", queueItemId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  if (!item) throw new SendRefusedError("not_found", "That queue item no longer exists.");

  // Idempotency guard. Checked before anything else so a retried callback is
  // cheap and, more importantly, silent.
  if (item.status === "sent" || item.status === "edited_sent") {
    const { data: logged } = await supabase
      .from("outreach_log")
      .select("provider_message_id, draft_message, email_subject")
      .eq("contact_id", item.contact_id)
      .eq("action_type", item.action_type)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return {
      status: "already_sent",
      providerMessageId: logged?.provider_message_id ?? null,
      channel: item.action_type === "email" ? "email" : "sms",
      body: logged?.draft_message ?? item.draft_message ?? "",
      subject: logged?.email_subject ?? item.email_subject ?? null,
      receipt: "Already sent — no duplicate was delivered.",
    };
  }

  if (item.action_type === "call") {
    throw new SendRefusedError(
      "call_not_sendable",
      "This is a call reminder. Calls are placed in Bonzo, not from here."
    );
  }

  const channel: "sms" | "email" = item.action_type === "email" ? "email" : "sms";
  const body = (options.overrideBody ?? item.draft_message ?? "").trim();
  const subject = (options.overrideSubject ?? item.email_subject ?? "").trim();

  if (!body) {
    throw new SendRefusedError("empty_body", "There is no message text to send.");
  }
  if (channel === "email" && !subject) {
    throw new SendRefusedError(
      "missing_subject",
      "This email has no subject line. Bonzo requires one."
    );
  }

  const { data: contact } = await supabase
    .from("contacts")
    .select("bonzo_prospect_id, name")
    .eq("id", item.contact_id)
    .maybeSingle();

  if (!contact?.bonzo_prospect_id) {
    throw new SendRefusedError(
      "no_prospect",
      "This contact is not linked to a Bonzo prospect, so there is nowhere to send."
    );
  }

  // Opt-out is checked live rather than from cache. Sending to someone who
  // opted out is a compliance problem, not an inconvenience, and the cache can
  // be up to fifteen minutes stale.
  const prospect = await getProspect(contact.bonzo_prospect_id).catch(() => null);
  if (prospect && isOptedOut(prospect, channel)) {
    await supabase
      .from("daily_queue")
      .update({ status: "skipped", completed_at: new Date().toISOString() })
      .eq("id", queueItemId);

    throw new SendRefusedError(
      "opted_out",
      `${contact.name} has opted out of ${channel}. Nothing was sent and the item was skipped.`
    );
  }

  let result: BonzoSendResult;
  try {
    result =
      channel === "sms"
        ? await sendSms(contact.bonzo_prospect_id, body)
        : await sendEmail(contact.bonzo_prospect_id, subject, body);
  } catch (e) {
    // Every failure is surfaced with what Bonzo actually said. A swallowed
    // send failure is the worst outcome available here: the item would look
    // handled and the lead would never hear anything.
    throw new SendRefusedError("bonzo_failed", describeSendFailure(e));
  }

  const now = new Date().toISOString();
  const wasEdited = options.overrideBody !== undefined;

  // Only now, with a confirmed send, does the item change state.
  await supabase
    .from("daily_queue")
    .update({
      status: wasEdited ? "edited_sent" : "sent",
      draft_message: body,
      email_subject: channel === "email" ? subject : null,
      completed_at: now,
    })
    .eq("id", queueItemId);

  await supabase.from("outreach_log").insert({
    user_id: userId,
    contact_id: item.contact_id,
    action_type: item.action_type,
    status: "sent",
    draft_message: body,
    email_subject: channel === "email" ? subject : null,
    provider_message_id: result.messageId || null,
  });

  return {
    status: "sent",
    providerMessageId: result.messageId || null,
    channel,
    body,
    subject: channel === "email" ? subject : null,
    receipt: `Sent to ${contact.name}${result.status ? ` (${result.status})` : ""}.`,
  };
}

/** Turns a Bonzo failure into something worth reading in Telegram. */
export function describeSendFailure(e: unknown): string {
  if (e instanceof BonzoRateLimitError) {
    return `Bonzo is rate limiting sends. Nothing was sent — try again in about ${Math.round(
      e.retryAfterMs / 1000
    )}s.`;
  }
  if (e instanceof BonzoSendRejectedError) {
    return `Bonzo accepted the request but reported the message ${e.status}. ${e.message}`;
  }
  if (e instanceof BonzoRequestError) {
    if (e.status === 422) {
      return `Bonzo rejected the message as invalid: ${extractValidationDetail(e.body)}`;
    }
    if (e.status === 404) {
      return "Bonzo could not find that prospect — it may have been deleted.";
    }
    return `Bonzo returned ${e.status}. Nothing was sent.`;
  }
  return e instanceof Error ? e.message : "Send failed for an unknown reason.";
}

/** Pulls the readable part out of a Laravel-style 422 body. */
function extractValidationDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      message?: string;
      errors?: Record<string, string[]>;
    };
    const fields = Object.entries(parsed.errors ?? {})
      .map(([field, msgs]) => `${field}: ${msgs.join(", ")}`)
      .join("; ");
    return fields || parsed.message || body.slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}
