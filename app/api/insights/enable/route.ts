import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  getCommunicationHistory,
  getProspect,
  getMortgageFields,
  type BonzoProspect,
} from "@/lib/bonzo/client";
import { refreshCache } from "@/lib/jobs/handlers";
import { enqueueJob } from "@/lib/jobs/queue";
import { runCallScan } from "@/lib/jobs/scan-calls";
import { waitUntil } from "@vercel/functions";

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

  // The full prospect payload carries the number; enrollment is the first
  // chance to keep it.
  const prospectPhone =
    (bonzoProspectData as { phone?: string | null } | null)?.phone ?? null;

  try {
    const { error: updateErr } = await serviceClient
      .from("contacts")
      .update({
        bonzo_prospect_id: bonzoProspectId,
        bonzo_email: bonzoEmail,
        insights_enabled: true,
        // 3.4 — captured at enrollment so a call reminder has a number to
        // show. Refresh keeps it current afterwards.
        ...(prospectPhone ? { phone: prospectPhone } : {}),
      })
      .eq("id", contactId);

    if (updateErr) throw updateErr;

    // Notes are pulled by the shared handler; only the history is needed here
    // to seed the cache row.
    const communications = await getCommunicationHistory(bonzoProspectId);

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

    // Seed the cache with the pulled state, then let the shared handler do
    // the analysis, classification and drafting. Enrolling used to call
    // analyzeProspect directly, which after the 1.7 consolidation would have
    // produced no drafts at all — and it never wrote a lead_state, so a
    // freshly enrolled lead entered the queue unclassified.
    const { error: cacheErr } = await serviceClient
      .from("insights_cache")
      .upsert(
        {
          contact_id: contactId,
          user_id: userId,
          bonzo_prospect_data: prospect,
          bonzo_communication: communications,
          ai_analysis: {},
          generated_at: new Date().toISOString(),
          // Null so the handler treats this as new and does a full pass.
          last_message_at: null,
        },
        { onConflict: "contact_id" }
      );

    if (cacheErr) throw cacheErr;

    await refreshCache(serviceClient, {
      id: `enable-${contactId}`,
      user_id: userId,
      contact_id: contactId,
      job_type: "refresh_cache",
      payload: { source: "enable" },
      status: "running",
      attempts: 1,
      last_error: null,
      run_after: new Date().toISOString(),
      locked_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      completed_at: null,
    });

    /*
     * Read the whole history for a call commitment, now that there is one to
     * read.
     *
     * This is the case that prompted the feature: a lead texts "call me at
     * noon tomorrow" in Bonzo, Eddie adds them here afterwards, and until now
     * nothing ever looked at what was said before the lead existed in this
     * app. The watermark is untouched, so the scan covers everything.
     *
     * Run twice over, deliberately.
     *
     * The queued job is the durable path: it retries, and it survives this
     * function being torn down mid-flight. But it waits for the worker's next
     * five-minute tick, and a call request is the one thing here with someone
     * else's clock attached — "call me at noon" read at 12:04 is worthless.
     *
     * So the scan also runs inline, after the response has already been sent,
     * which makes the common case immediate. The second run is nearly free and
     * cannot double up: the inline pass advances calls_scanned_through, so the
     * queued one finds no new messages and returns after a single Bonzo read.
     * recordProposedCall and the wants-call write are both idempotent anyway.
     */
    await enqueueJob(serviceClient, {
      userId,
      contactId,
      jobType: "scan_calls",
    }).catch((e: unknown) =>
      console.error("[insights/enable] call scan enqueue failed:", e)
    );

    waitUntil(
      runCallScan(serviceClient, contactId)
        .then((r) => console.log(`[insights/enable] inline call scan: ${r.summary}`))
        .catch((e: unknown) =>
          // The queued job above is the safety net; nothing is lost here.
          console.error("[insights/enable] inline call scan failed:", e)
        )
    );

    const { data: cache } = await serviceClient
      .from("insights_cache")
      .select("ai_analysis, bonzo_communication, lead_state, generated_at")
      .eq("contact_id", contactId)
      .maybeSingle();

    return NextResponse.json({
      aiAnalysis: cache?.ai_analysis ?? null,
      communications: cache?.bonzo_communication ?? communications,
      leadState: cache?.lead_state ?? null,
      generatedAt: cache?.generated_at ?? new Date().toISOString(),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to generate insights";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
