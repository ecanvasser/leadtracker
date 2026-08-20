import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { localDateFor } from "@/lib/time";
import { sendQueueItem, SendRefusedError } from "@/lib/outreach/send";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = authData.claims.sub as string;
  const { queueItemId, action, editedMessage, editedSubject } = await request.json();

  if (!queueItemId || !action) {
    return NextResponse.json({ error: "queueItemId and action required" }, { status: 400 });
  }

  const validActions = ["send", "edit_send", "skip", "done"];
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
  // Non-sending actions: skip and done.
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

  return NextResponse.json({ next: nextItem ?? null });
}
