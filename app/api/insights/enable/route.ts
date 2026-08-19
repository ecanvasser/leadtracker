import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  getCommunicationHistory,
  getProspectNotes,
  type BonzoProspect,
} from "@/lib/bonzo/client";
import { analyzeProspect } from "@/lib/insights/analyze";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = authData.claims.sub as string;
  const { contactId, bonzoProspectId, bonzoEmail, bonzoProspectData } =
    await request.json();

  if (!contactId || !bonzoProspectId || !bonzoEmail) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  const serviceClient = createServiceClient();

  const { data: contact, error: contactErr } = await serviceClient
    .from("contacts")
    .select("id, user_id")
    .eq("id", contactId)
    .eq("user_id", userId)
    .single();

  if (contactErr || !contact) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  try {
    const { error: updateErr } = await serviceClient
      .from("contacts")
      .update({
        bonzo_prospect_id: bonzoProspectId,
        bonzo_email: bonzoEmail,
        insights_enabled: true,
      })
      .eq("id", contactId);

    if (updateErr) throw updateErr;

    const [communications, notes] = await Promise.all([
      getCommunicationHistory(bonzoProspectId),
      getProspectNotes(bonzoProspectId),
    ]);

    const prospect = bonzoProspectData as BonzoProspect;
    const aiAnalysis = await analyzeProspect(prospect, communications, notes);

    const { error: cacheErr } = await serviceClient
      .from("insights_cache")
      .upsert(
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

    if (cacheErr) {
      await serviceClient.from("insights_cache").insert({
        contact_id: contactId,
        user_id: userId,
        bonzo_prospect_data: prospect,
        bonzo_communication: communications,
        ai_analysis: aiAnalysis,
        generated_at: new Date().toISOString(),
      });
    }

    return NextResponse.json({
      aiAnalysis,
      communications,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to generate insights";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
