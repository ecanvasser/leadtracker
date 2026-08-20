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

  const { data: queue } = await supabase
    .from("daily_queue")
    .select("*, contacts(name, loan_type, crm, stage, created_at, insights_enabled)")
    .eq("user_id", userId)
    .eq("queue_date", todayStr)
    .order("priority_rank", { ascending: true });

  if (!queue || queue.length === 0) {
    return NextResponse.json({ generated: false, queue: [] });
  }

  return NextResponse.json({ generated: true, queue });
}
