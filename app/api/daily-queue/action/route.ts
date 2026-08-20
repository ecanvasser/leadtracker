import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  localDateFor,
  localDate,
  addLocalDays,
  getUserTimezone,
} from "@/lib/time";
import { sendQueueItem, SendRefusedError } from "@/lib/outreach/send";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = authData.claims.sub as string;
  const { queueItemId, action, editedMessage, editedSubject, snoozeOption, holdDays } =
    await request.json();

  if (!queueItemId || !action) {
    return NextResponse.json({ error: "queueItemId and action required" }, { status: 400 });
  }

  // 4.3 — skip used to collapse "not right now" and "this lead is dead" into
  // one button. They are now distinct outcomes:
  //   snooze — comes back later today or another day, stays pending
  //   skip   — not this touch; logged and gone for today
  //   hold   — stop contacting this lead for a while
  const validActions = ["send", "edit_send", "skip", "done", "snooze", "hold", "undo"];
  if (!validActions.includes(action)) {
    return NextResponse.json({ error: `Invalid action: ${action}` }, { status: 400 });
  }

  const serviceClient = createServiceClient();

  const { data: item, error: itemErr } = await serviceClient
    .from("daily_queue")
    .select("*")
    .eq("id", queueItemId)
    .eq("user_id", userId)
    .single();

  if (itemErr || !item) {
    return NextResponse.json({ error: "Queue item not found" }, { status: 404 });
  }

  // ---------------------------------------------------------------------
  // Send actions go through Bonzo. The item is marked sent only once Bonzo
  // confirms, so a failed send leaves the card pending rather than showing a
  // checkmark next to a lead who was never contacted.
  // ---------------------------------------------------------------------
  if (action === "send" || action === "edit_send") {
    if (item.action_type === "call") {
      return NextResponse.json(
        { error: "Calls are placed in Bonzo. Use Done once you've made it." },
        { status: 400 }
      );
    }

    try {
      const outcome = await sendQueueItem(serviceClient, userId, queueItemId, {
        ...(action === "edit_send" && typeof editedMessage === "string"
          ? { overrideBody: editedMessage }
          : {}),
        ...(typeof editedSubject === "string" && editedSubject.trim()
          ? { overrideSubject: editedSubject }
          : {}),
      });

      const todayStr = await localDateFor(userId);
      const { data: nextItem } = await serviceClient
        .from("daily_queue")
        .select("*, contacts(name, loan_type, crm, stage, created_at, insights_enabled)")
        .eq("user_id", userId)
        .eq("queue_date", todayStr)
        .eq("status", "pending")
        .order("priority_rank", { ascending: true })
        .limit(1)
        .maybeSingle();

      return NextResponse.json({ next: nextItem ?? null, outcome });
    } catch (e) {
      if (e instanceof SendRefusedError) {
        // Surfaced verbatim. Never swallow a failed send.
        return NextResponse.json(
          { error: e.message, reason: e.reason },
          { status: 400 }
        );
      }
      throw e;
    }
  }

  // ---------------------------------------------------------------------
  // Snooze — "not right now". Stays pending so it returns, and clears any
  // outstanding Telegram card so the throttle slot is freed.
  // ---------------------------------------------------------------------
  if (action === "snooze") {
    const until = snoozeTarget(snoozeOption, await getUserTimezone(userId, serviceClient));

    await serviceClient
      .from("daily_queue")
      .update({ snoozed_until: until.toISOString(), telegram_message_id: null })
      .eq("id", queueItemId);

    return NextResponse.json({
      next: await nextPending(serviceClient, userId),
      snoozedUntil: until.toISOString(),
    });
  }

  // ---------------------------------------------------------------------
  // Hold — "stop working this lead for a while". Distinct from skip: it
  // suppresses the lead itself rather than one touch, so the cadence engine
  // stops producing actions for it until the date passes.
  // ---------------------------------------------------------------------
  if (action === "hold") {
    const days = Number.isFinite(Number(holdDays)) ? Number(holdDays) : 14;
    const until = new Date(Date.now() + days * 86_400_000);

    await serviceClient
      .from("daily_queue")
      .update({ status: "skipped", completed_at: new Date().toISOString() })
      .eq("id", queueItemId);

    // suppress_until lives on lead_state, which is what the engine reads.
    const { data: cache } = await serviceClient
      .from("insights_cache")
      .select("lead_state")
      .eq("contact_id", item.contact_id)
      .maybeSingle();

    const leadState = (cache?.lead_state as Record<string, unknown> | null) ?? {};
    await serviceClient
      .from("insights_cache")
      .update({
        lead_state: { ...leadState, suppress_until: until.toISOString() },
      })
      .eq("contact_id", item.contact_id);

    await serviceClient.from("outreach_log").insert({
      user_id: userId,
      contact_id: item.contact_id,
      action_type: item.action_type,
      status: "held",
      draft_message: `Held for ${days} days`,
    });

    return NextResponse.json({
      next: await nextPending(serviceClient, userId),
      heldUntil: until.toISOString(),
    });
  }

  // ---------------------------------------------------------------------
  // Undo — returns an actioned item to pending.
  //
  // Only reaches here for actions that did not send. A delivered message
  // cannot be recalled, which is why the client holds sends for ten seconds
  // rather than trying to reverse them afterwards.
  // ---------------------------------------------------------------------
  if (action === "undo") {
    if (item.status === "sent" || item.status === "edited_sent") {
      return NextResponse.json(
        { error: "That message was already delivered and cannot be recalled." },
        { status: 400 }
      );
    }

    await serviceClient
      .from("daily_queue")
      .update({ status: "pending", completed_at: null, snoozed_until: null })
      .eq("id", queueItemId);

    // Remove the log entry this action wrote, so an undone skip leaves no
    // trace in the record of what was actually done.
    await serviceClient
      .from("outreach_log")
      .delete()
      .eq("contact_id", item.contact_id)
      .in("status", ["skipped", "held", "done"])
      .gte("created_at", new Date(Date.now() - 5 * 60_000).toISOString());

    return NextResponse.json({ restored: true });
  }

  // ---------------------------------------------------------------------
  // Skip and done.
  // ---------------------------------------------------------------------
  const statusMap: Record<string, string> = {
    skip: "skipped",
    done: "done",
  };

  await serviceClient
    .from("daily_queue")
    .update({
      status: statusMap[action],
      completed_at: new Date().toISOString(),
    })
    .eq("id", queueItemId);

  await serviceClient.from("outreach_log").insert({
    user_id: userId,
    contact_id: item.contact_id,
    action_type: item.action_type,
    status: action === "skip" ? "skipped" : "done",
    draft_message: item.draft_message,
    email_subject: item.email_subject ?? null,
  });

  return NextResponse.json({ next: await nextPending(serviceClient, userId) });
}

/** The next card to show: pending, not snoozed into the future, top priority. */
async function nextPending(serviceClient: SupabaseClient, userId: string) {
  const todayStr = await localDateFor(userId);
  const now = new Date().toISOString();

  const { data } = await serviceClient
    .from("daily_queue")
    .select("*, contacts(name, loan_type, crm, stage, created_at, insights_enabled)")
    .eq("user_id", userId)
    .eq("queue_date", todayStr)
    .eq("status", "pending")
    .or(`snoozed_until.is.null,snoozed_until.lte.${now}`)
    .order("priority_rank", { ascending: true })
    .limit(1)
    .maybeSingle();

  return data ?? null;
}

/** Snooze targets, matching the Telegram options. */
function snoozeTarget(option: string | undefined, timeZone: string): Date {
  const now = new Date();
  switch (option) {
    case "2h":
      return new Date(now.getTime() + 2 * 60 * 60 * 1000);
    case "3d":
      return atLocalHour(addLocalDays(localDate(now, timeZone), 3), 9, timeZone);
    case "wk":
      return atLocalHour(addLocalDays(localDate(now, timeZone), 7), 9, timeZone);
    case "am":
    default:
      return atLocalHour(addLocalDays(localDate(now, timeZone), 1), 9, timeZone);
  }
}

/** Probes the zone rather than assuming an offset, so DST cannot shift this. */
function atLocalHour(date: string, hour: number, timeZone: string): Date {
  const guess = new Date(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
  const observed = Number(
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false })
      .formatToParts(guess)
      .find((p) => p.type === "hour")?.value ?? hour
  );
  return new Date(guess.getTime() + (hour - observed) * 60 * 60 * 1000);
}
