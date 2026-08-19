import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = authData.claims.sub as string;
  const { queueItemId, action, editedMessage } = await request.json();

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

  const statusMap: Record<string, string> = {
    send: "sent",
    edit_send: "edited_sent",
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

  const outreachStatus = action === "skip" ? "skipped" : "sent";
  const message = action === "edit_send" ? editedMessage : item.draft_message;

  await serviceClient.from("outreach_log").insert({
    user_id: userId,
    contact_id: item.contact_id,
    action_type: item.action_type,
    status: outreachStatus,
    draft_message: message,
  });

  const todayStr = new Date().toISOString().split("T")[0];
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
