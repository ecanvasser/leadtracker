import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ contactId: string }> }
) {
  const { contactId } = await params;
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: cache } = await supabase
    .from("insights_cache")
    .select("*")
    .eq("contact_id", contactId)
    .maybeSingle();

  if (!cache) {
    return NextResponse.json({ cached: false });
  }

  return NextResponse.json({
    cached: true,
    aiAnalysis: cache.ai_analysis,
    communications: cache.bonzo_communication,
    prospectData: cache.bonzo_prospect_data,
    generatedAt: cache.generated_at,
  });
}
