import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  searchProspectByEmail,
  getCommunicationHistory,
  getProspectNotes,
} from "@/lib/bonzo/client";
import { analyzeProspect } from "@/lib/insights/analyze";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = authData.claims.sub as string;
  const { contactId } = await request.json();

  if (!contactId) {
    return NextResponse.json({ error: "contactId required" }, { status: 400 });
  }

  const serviceClient = createServiceClient();

  const { data: contact, error: contactErr } = await serviceClient
    .from("contacts")
    .select("id, user_id, bonzo_prospect_id, bonzo_email, insights_enabled")
    .eq("id", contactId)
    .eq("user_id", userId)
    .single();

  if (contactErr || !contact) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  if (!contact.insights_enabled || !contact.bonzo_email) {
    return NextResponse.json(
      { error: "Insights not enabled for this contact" },
      { status: 400 }
    );
  }

  try {
    const prospect = await searchProspectByEmail(contact.bonzo_email);
    if (!prospect) {
      return NextResponse.json(
        { error: "Bonzo prospect no longer found" },
        { status: 404 }
      );
    }

    const [communications, notes] = await Promise.all([
      getCommunicationHistory(prospect.id),
      getProspectNotes(prospect.id),
    ]);

    const aiAnalysis = await analyzeProspect(prospect, communications, notes);

    await serviceClient.from("insights_cache").upsert(
      {
        contact_id: contactId,
        user_id: userId,
        bonzo_prospect_data: prospect,
        bonzo_communication: communications,
        ai_analysis: aiAnalysis,
        generated_at: new Date().toISOString(),
      },
      { onConflict: "contact_id" }
    );

    return NextResponse.json({
      aiAnalysis,
      communications,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to refresh insights";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
