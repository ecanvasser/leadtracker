/**
 * Manual refresh from the contact page.
 *
 * Runs the same handler the job queue runs rather than duplicating it. This
 * route previously had its own copy of the fetch/analyze/upsert sequence,
 * which is how it drifted: it always called the model, ignored the watermark,
 * and produced drafts from a different prompt than the queue.
 *
 * The button is a manual trigger, so the watermark is bypassed deliberately —
 * clicking Refresh should re-read even when nothing changed. That is one
 * intentional model call, not a poll.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { refreshCache } from "@/lib/jobs/handlers";
import type { Job } from "@/lib/jobs/queue";

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
    .select("id, user_id, insights_enabled, bonzo_email")
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

  // Clearing the watermark forces a full re-read and reclassification. A
  // manual refresh that reported "no new messages" and did nothing would look
  // broken.
  await serviceClient
    .from("insights_cache")
    .update({ last_message_at: null })
    .eq("contact_id", contactId);

  const syntheticJob: Job = {
    id: `manual-${contactId}`,
    user_id: userId,
    contact_id: contactId,
    job_type: "refresh_cache",
    payload: { source: "manual" },
    status: "running",
    attempts: 1,
    last_error: null,
    run_after: new Date().toISOString(),
    locked_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    completed_at: null,
  };

  try {
    await refreshCache(serviceClient, syntheticJob);

    const { data: cache } = await serviceClient
      .from("insights_cache")
      .select("ai_analysis, bonzo_communication, lead_state, generated_at")
      .eq("contact_id", contactId)
      .maybeSingle();

    return NextResponse.json({
      aiAnalysis: cache?.ai_analysis ?? null,
      communications: cache?.bonzo_communication ?? [],
      leadState: cache?.lead_state ?? null,
      generatedAt: cache?.generated_at ?? new Date().toISOString(),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to refresh insights";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
