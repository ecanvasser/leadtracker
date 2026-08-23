import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getUserTimezone, localDate } from "@/lib/time";
import { ALL_STAGES, type AllStages } from "@/types/db";

/**
 * The inline actions on a Today row (section 2.3).
 *
 * Deliberately small. Everything here either records something Eddie has
 * already done or changes one field; nothing here sends a message. Opening
 * the contact page should be optional, not the default path — but so should
 * this route growing into a second contact page.
 */
const ACTIONS = ["done", "snooze", "unsnooze", "stage"] as const;
type Action = (typeof ACTIONS)[number];

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = authData.claims.sub as string;

  const { contactId, action, days, stage } = (await request.json()) as {
    contactId?: string;
    action?: Action;
    days?: number;
    stage?: AllStages;
  };

  if (!contactId || !action || !ACTIONS.includes(action)) {
    return NextResponse.json({ error: "contactId and a valid action are required" }, { status: 400 });
  }

  const service = createServiceClient();

  // Ownership is checked here rather than relied on from RLS, because the
  // service client below deliberately bypasses it.
  const { data: contact } = await service
    .from("contacts")
    .select("id, user_id, stage")
    .eq("id", contactId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!contact) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  // -------------------------------------------------------------------------
  // Done — "I have handled this."
  //
  // Two effects, both records of something that already happened rather than
  // anything new: any task that was making the row actionable is closed, and
  // the action is logged. lib/turn/load.ts folds that log entry into the
  // outbound watermark, which is what moves the row out of Your move now
  // instead of at the next sweep.
  // -------------------------------------------------------------------------
  if (action === "done") {
    const timeZone = await getUserTimezone(userId, service);
    const today = localDate(new Date(), timeZone);

    const { data: closed } = await service
      .from("tasks")
      .update({ is_done: true, completed_at: new Date().toISOString() })
      .eq("contact_id", contactId)
      .eq("user_id", userId)
      .eq("is_done", false)
      .lte("due_date", today)
      .select("id");

    await service.from("outreach_log").insert({
      user_id: userId,
      contact_id: contactId,
      action_type: "handled",
      // Not 'sent' — nothing was sent from here. 'done' is its own outcome and
      // the loader counts it alongside a real send, because both mean the ball
      // is back in the lead's court.
      status: "done",
      draft_message: "Marked done from Today",
    });

    return NextResponse.json({ ok: true, tasksClosed: closed?.length ?? 0 });
  }

  // -------------------------------------------------------------------------
  // Snooze — suppress_until on lead_state, which is where every other part of
  // the app already looks for it (the cadence engine, the classifier's hold
  // rule, and the queue's own snooze). A second mechanism would mean two
  // places to check before believing a lead is quiet on purpose.
  // -------------------------------------------------------------------------
  if (action === "snooze" || action === "unsnooze") {
    const { data: cache } = await service
      .from("insights_cache")
      .select("lead_state")
      .eq("contact_id", contactId)
      .maybeSingle();

    const leadState = (cache?.lead_state as Record<string, unknown> | null) ?? {};

    const until =
      action === "unsnooze"
        ? null
        : new Date(
            Date.now() + Math.max(1, Math.min(90, Number(days) || 1)) * 86_400_000
          ).toISOString();

    // upsert, not update: a lead the sweep has not reached yet has no cache
    // row, and an update would report success having written nothing.
    const { error } = await service.from("insights_cache").upsert(
      {
        contact_id: contactId,
        user_id: userId,
        lead_state: { ...leadState, suppress_until: until },
      },
      { onConflict: "contact_id" }
    );
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, snoozedUntil: until });
  }

  // -------------------------------------------------------------------------
  // Stage — the same write the board makes, so the same database trigger logs
  // it to stage_transitions. Nothing about the history depends on which
  // surface the change came from.
  // -------------------------------------------------------------------------
  if (!stage || !ALL_STAGES.includes(stage)) {
    return NextResponse.json({ error: "A valid stage is required" }, { status: 400 });
  }

  const { error } = await service
    .from("contacts")
    .update({ stage })
    .eq("id", contactId)
    .eq("user_id", userId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, stage });
}
