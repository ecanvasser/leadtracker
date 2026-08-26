import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getUserTimezone } from "@/lib/time";
import { instantForLocalTime } from "@/lib/calls/timezone";

type Action = "confirm" | "cancel" | "completed" | "missed" | "reschedule";

/**
 * PATCH /api/calls/:callId — move a call along, or move it.
 *
 * `completed` and `missed` are terminal outcomes, and both stop the reminder
 * dispatcher looking at the row. Recording a miss matters as much as recording
 * a success: a call that simply stays "confirmed" forever after its time has
 * passed is what makes an overdue list untrustworthy.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ callId: string }> }
) {
  const { callId } = await params;

  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = authData.claims.sub as string;

  const body = (await request.json().catch(() => null)) as {
    action?: Action;
    date?: string;
    time?: string;
  } | null;

  const action = body?.action;
  if (
    !action ||
    !["confirm", "cancel", "completed", "missed", "reschedule"].includes(action)
  ) {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const service = createServiceClient();

  const { data: call } = await service
    .from("scheduled_calls")
    .select("id, user_id, contact_id, status")
    .eq("id", callId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!call) return NextResponse.json({ error: "Call not found" }, { status: 404 });

  if (action === "reschedule") {
    if (!body?.date || !body?.time) {
      return NextResponse.json(
        { error: "A new date and time are required." },
        { status: 400 }
      );
    }
    const timeZone = await getUserTimezone(userId, service);
    const [hour, minute] = body.time.split(":").map(Number);
    const scheduledAt = instantForLocalTime(body.date, hour, minute, timeZone);

    if (scheduledAt.getTime() < Date.now()) {
      return NextResponse.json({ error: "That time is in the past." }, { status: 400 });
    }

    /*
     * Reminders are cleared along with the time. They record that a specific
     * call was announced, and after a move that is no longer true — leaving
     * them set would silently skip the T-15 on the new slot.
     */
    const { error } = await service
      .from("scheduled_calls")
      .update({
        scheduled_at: scheduledAt.toISOString(),
        status: "confirmed",
        reminded_t15_at: null,
        reminded_t0_at: null,
        outcome_asked_at: null,
      })
      .eq("id", callId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, scheduledAt: scheduledAt.toISOString() });
  }

  const status =
    action === "confirm"
      ? "confirmed"
      : action === "cancel"
        ? "cancelled"
        : action === "completed"
          ? "completed"
          : "missed";

  const { error } = await service
    .from("scheduled_calls")
    .update({ status })
    .eq("id", callId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, status });
}
