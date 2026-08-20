/**
 * Call reminder dispatcher.
 *
 * The one piece of background work that genuinely belongs in an Edge Function:
 * a single query for due reminders plus a Telegram send, next to the database,
 * with no Anthropic SDK and no shared domain code. Everything else stays in
 * the Next.js app so it can import the cadence engine and Bonzo client
 * directly rather than duplicating them across runtimes.
 *
 * Keep this surface minimal. If it ever needs the cadence engine, move it back
 * into the app rather than copying code here.
 *
 * Auth is a shared secret, matching the queue worker. Deliberately not a JWT:
 * signing one inside Postgres would mean pgjwt (deprecated in PG 17) or
 * pgsodium (Supabase advises against new usage), and both are the rough edge
 * the deployment notes say to avoid.
 *
 * Deploy:  supabase functions deploy call-reminders --no-verify-jwt
 * Secrets: supabase secrets set REMINDER_SECRET=... TELEGRAM_BOT_TOKEN=...
 *
 * --no-verify-jwt is required: pg_cron calls this with a bearer shared secret,
 * not a Supabase JWT, so the platform's own verification would reject it
 * before this code runs.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/** Reminder offsets before the call, in minutes. */
const T_MINUS_15 = 15;

/** How late a call can be before the outcome prompt goes out. */
const OUTCOME_DELAY_MIN = 20;

/** Tolerance either side of a reminder time, so a slow minute cannot skip one. */
const WINDOW_MIN = 3;

interface ScheduledCall {
  id: string;
  user_id: string;
  contact_id: string;
  scheduled_at: string;
  prospect_timezone: string;
  timezone_source: string;
  source_quote: string;
  reminded_t15_at: string | null;
  reminded_t0_at: string | null;
  outcome_asked_at: string | null;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatInZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(instant);
}

function zoneAbbrev(timeZone: string, instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "short",
  }).formatToParts(instant);
  return parts.find((p) => p.type === "timeZoneName")?.value ?? timeZone;
}

/**
 * Both times, always. The whole class of bug this guards against is a reminder
 * that quietly means a different hour than the reader assumes.
 */
function bothZones(instant: Date, theirZone: string, myZone: string): string {
  const theirs = `${formatInZone(instant, theirZone)} ${zoneAbbrev(theirZone, instant)}`;
  if (formatInZone(instant, theirZone) === formatInZone(instant, myZone)) {
    return `${theirs} (same time for you both)`;
  }
  const mine = `${formatInZone(instant, myZone)} ${zoneAbbrev(myZone, instant)}`;
  return `${theirs} (their time) — ${mine} (yours)`;
}

async function sendTelegram(
  botToken: string,
  chatId: number,
  text: string,
  replyMarkup?: unknown
): Promise<boolean> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
  if (!res.ok) {
    console.error("[call-reminders] telegram send failed:", res.status, await res.text());
    return false;
  }
  return true;
}

Deno.serve(async (req: Request) => {
  const expected = Deno.env.get("REMINDER_SECRET");
  if (!expected) {
    return new Response(JSON.stringify({ error: "REMINDER_SECRET not set" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !constantTimeEquals(token, expected)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!botToken) {
    return new Response(JSON.stringify({ error: "TELEGRAM_BOT_TOKEN not set" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const now = new Date();
  const sent = { t15: 0, t0: 0, outcome: 0 };

  // One query for everything plausibly due: from a little before T-15 through
  // the outcome window.
  const from = new Date(now.getTime() - (OUTCOME_DELAY_MIN + 60) * 60_000);
  const to = new Date(now.getTime() + (T_MINUS_15 + WINDOW_MIN) * 60_000);

  const { data: calls, error } = await supabase
    .from("scheduled_calls")
    .select(
      "id, user_id, contact_id, scheduled_at, prospect_timezone, timezone_source, source_quote, reminded_t15_at, reminded_t0_at, outcome_asked_at"
    )
    .eq("status", "confirmed")
    .gte("scheduled_at", from.toISOString())
    .lte("scheduled_at", to.toISOString());

  if (error) {
    console.error("[call-reminders] query failed:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  for (const call of (calls ?? []) as ScheduledCall[]) {
    const at = new Date(call.scheduled_at);
    const minutesUntil = (at.getTime() - now.getTime()) / 60_000;

    const [{ data: contact }, { data: link }, { data: settings }] = await Promise.all([
      supabase
        .from("contacts")
        .select("name, phone, bonzo_prospect_id")
        .eq("id", call.contact_id)
        .maybeSingle(),
      supabase
        .from("telegram_links")
        .select("telegram_user_id")
        .eq("user_id", call.user_id)
        .maybeSingle(),
      supabase
        .from("user_settings")
        .select("timezone")
        .eq("user_id", call.user_id)
        .maybeSingle(),
    ]);

    if (!contact || !link) continue;

    const myZone = settings?.timezone ?? "America/Los_Angeles";
    const chatId = link.telegram_user_id as number;

    // Talking points come from the queue item for this contact, if one exists.
    const { data: queueItem } = await supabase
      .from("daily_queue")
      .select("call_talking_points")
      .eq("contact_id", call.contact_id)
      .not("call_talking_points", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const header = (label: string) =>
      [
        `📞 <b>${label} — ${escapeHtml(contact.name)}</b>`,
        "",
        bothZones(at, call.prospect_timezone, myZone),
      ].join("\n");

    const body: string[] = [];
    if (contact.phone) {
      // Plain text on purpose. This app reminds; it never dials, and a tel:
      // link is the first step toward pretending otherwise.
      body.push("", `Number: <code>${escapeHtml(contact.phone)}</code>`);
    }
    if (queueItem?.call_talking_points) {
      body.push("", "<b>Talking points</b>", `<pre>${escapeHtml(queueItem.call_talking_points)}</pre>`);
    }
    body.push("", `Agreed here:`, `<blockquote>${escapeHtml(call.source_quote)}</blockquote>`);

    const bonzoButton = contact.bonzo_prospect_id
      ? {
          inline_keyboard: [
            [
              {
                text: "Open in Bonzo",
                url: `https://platform.getbonzo.com/prospect/${contact.bonzo_prospect_id}`,
              },
            ],
          ],
        }
      : undefined;

    // T-15
    if (
      !call.reminded_t15_at &&
      minutesUntil <= T_MINUS_15 + WINDOW_MIN &&
      minutesUntil > 1
    ) {
      // Stamp before sending: a duplicate reminder is worse than a missed one
      // here, since the send is not transactional with the update.
      await supabase
        .from("scheduled_calls")
        .update({ reminded_t15_at: now.toISOString() })
        .eq("id", call.id);

      if (await sendTelegram(botToken, chatId, [header("In 15 minutes"), ...body].join("\n"), bonzoButton)) {
        sent.t15++;
      }
      continue;
    }

    // T-0
    if (!call.reminded_t0_at && minutesUntil <= 1 && minutesUntil > -WINDOW_MIN) {
      await supabase
        .from("scheduled_calls")
        .update({ reminded_t0_at: now.toISOString() })
        .eq("id", call.id);

      if (await sendTelegram(botToken, chatId, [header("Now"), ...body].join("\n"), bonzoButton)) {
        sent.t0++;
      }
      continue;
    }

    // Outcome prompt, once the window has clearly passed.
    if (
      !call.outcome_asked_at &&
      minutesUntil <= -OUTCOME_DELAY_MIN &&
      minutesUntil > -(OUTCOME_DELAY_MIN + 60)
    ) {
      await supabase
        .from("scheduled_calls")
        .update({ outcome_asked_at: now.toISOString() })
        .eq("id", call.id);

      const asked = await sendTelegram(
        botToken,
        chatId,
        `📞 <b>${escapeHtml(contact.name)}</b> — how did the call go?`,
        {
          inline_keyboard: [
            [
              { text: "✅ Completed", callback_data: `cod:${call.id}` },
              { text: "📵 No answer", callback_data: `cona:${call.id}` },
            ],
            [{ text: "🔁 Reschedule", callback_data: `cor:${call.id}` }],
          ],
        }
      );
      if (asked) sent.outcome++;
    }
  }

  return new Response(
    JSON.stringify({ checked: calls?.length ?? 0, sent }),
    { headers: { "Content-Type": "application/json" } }
  );
});
