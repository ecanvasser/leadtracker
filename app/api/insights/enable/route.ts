import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  getCommunicationHistory,
  getProspectNotes,
  getProspect,
  getMortgageFields,
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

    // The client sends the full record from search-bonzo. If it ever arrives
    // truncated again, re-read it here rather than caching a stub — a cache
    // row without mortgage data is the whole context-starvation bug.
    let prospect = bonzoProspectData as BonzoProspect;
    if (getMortgageFields(prospect) === null) {
      const refetched = await getProspect(bonzoProspectId).catch(() => null);
      if (refetched) prospect = refetched;
    }

    if (getMortgageFields(prospect) === null) {
      // Loud on purpose. Every draft for this lead will be written without
      // loan amount, credit score, property value, purpose or employment.
      console.error(
        `[insights/enable] No mortgage fields for Bonzo prospect ${bonzoProspectId} ` +
          `(contact ${contactId}). Drafts for this lead will lack loan context. ` +
          `Keys present: ${Object.keys(prospect ?? {}).join(", ") || "none"}`
      );
    }

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

    if (cacheErr) throw cacheErr;

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
