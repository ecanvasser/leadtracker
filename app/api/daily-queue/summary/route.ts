import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { localDateFor } from "@/lib/time";

export async function GET() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = authData.claims.sub as string;
  const todayStr = await localDateFor(userId);

  const { data: items } = await supabase
    .from("daily_queue")
    .select("status, contact_id")
    .eq("user_id", userId)
    .eq("queue_date", todayStr);

  if (!items || items.length === 0) {
    return NextResponse.json({
      total: 0,
      sent: 0,
      skipped: 0,
      done: 0,
      pending: 0,
      generated: false,
    });
  }

  const sent = items.filter((i) => i.status === "sent" || i.status === "edited_sent").length;
  const skipped = items.filter((i) => i.status === "skipped").length;
  const done = items.filter((i) => i.status === "done").length;
  const pending = items.filter((i) => i.status === "pending").length;

  return NextResponse.json({
    total: items.length,
    sent,
    skipped,
    done,
    pending,
    generated: true,
  });
}
