/**
 * Redrafting a queue item from a plain-language instruction.
 *
 * Shares lib/ai/revise.ts with the Telegram Redraft button, so both surfaces
 * hold a redraft to the same constraints. A redraft path that skipped
 * validation would be the easy way to reintroduce every banned construction —
 * "make it warmer" is exactly the instruction that produces them.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { reviseQueueDraft } from "@/lib/ai/revise";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = authData.claims.sub as string;
  const { queueItemId, instruction } = await request.json();

  if (!queueItemId || !instruction?.trim()) {
    return NextResponse.json(
      { error: "queueItemId and instruction are required" },
      { status: 400 }
    );
  }

  const serviceClient = createServiceClient();

  try {
    const revised = await reviseQueueDraft(
      serviceClient,
      userId,
      queueItemId,
      instruction.trim()
    );

    // Persist so the redraft survives a reload, and so Telegram and the web
    // queue show the same text.
    await serviceClient
      .from("daily_queue")
      .update({
        draft_message: revised.body,
        ...(revised.subject !== null ? { email_subject: revised.subject } : {}),
      })
      .eq("id", queueItemId)
      .eq("user_id", userId);

    return NextResponse.json(revised);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Redraft failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
