import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { handleWantsCallDismiss } from "@/lib/telegram/call-confirm";

/**
 * PATCH /api/calls/wants — dismiss a "wants to talk" prompt.
 *
 * Dismissed rather than deleted: the row keeps the request so a later scan can
 * tell "already answered" from "never asked", and a newer message from the
 * same lead lifts the dismissal. Asking twice is a stronger signal than asking
 * once and should not be silently swallowed by an earlier dismissal.
 */
export async function PATCH(request: NextRequest) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    contactId?: string;
  } | null;

  if (!body?.contactId) {
    return NextResponse.json({ error: "contactId is required" }, { status: 400 });
  }

  const service = createServiceClient();

  // Scoped to the caller's own lead: the handler takes a contact id and would
  // otherwise act on any row given one.
  const { data: contact } = await service
    .from("contacts")
    .select("id")
    .eq("id", body.contactId)
    .eq("user_id", authData.claims.sub as string)
    .maybeSingle();

  if (!contact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await handleWantsCallDismiss(service, body.contactId);
  return NextResponse.json({ ok: true });
}
