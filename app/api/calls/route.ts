import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { bookCall, callsForDay, overdueCalls, wantsCallLeads } from "@/lib/calls/book";
import { getUserTimezone, localDate } from "@/lib/time";
import { instantForLocalTime } from "@/lib/calls/timezone";

/**
 * GET /api/calls — the day's calls, plus anything overdue.
 *
 * `?day=YYYY-MM-DD` for a specific local day; defaults to today. `?contactId=`
 * narrows to one lead, which is what the contact page asks for.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = authData.claims.sub as string;
  const service = createServiceClient();
  const timeZone = await getUserTimezone(userId, service);

  const contactId = request.nextUrl.searchParams.get("contactId");
  if (contactId) {
    const { data } = await service
      .from("scheduled_calls")
      .select("*")
      .eq("contact_id", contactId)
      .in("status", ["proposed", "confirmed"])
      .order("scheduled_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    return NextResponse.json({ call: data ?? null, timeZone });
  }

  const day = request.nextUrl.searchParams.get("day") ?? localDate(new Date(), timeZone);

  const [calls, overdue, wantsCall] = await Promise.all([
    callsForDay(service, userId, timeZone, day),
    overdueCalls(service, userId),
    wantsCallLeads(service, userId),
  ]);

  return NextResponse.json({ day, timeZone, calls, overdue, wantsCall });
}

/**
 * POST /api/calls — book one by hand.
 *
 * Takes a local date and time as the broker typed them, not an instant. The
 * conversion happens here, through the same helper the detector uses, so a
 * call booked by hand and one read out of a message land on the same rules —
 * including across a DST boundary.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = authData.claims.sub as string;

  const body = (await request.json().catch(() => null)) as {
    contactId?: string;
    date?: string;
    time?: string;
    note?: string;
    replace?: boolean;
  } | null;

  if (!body?.contactId || !body.date || !body.time) {
    return NextResponse.json(
      { error: "A lead, a date and a time are all required." },
      { status: 400 }
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    return NextResponse.json({ error: "Date must be YYYY-MM-DD." }, { status: 400 });
  }
  if (!/^\d{1,2}:\d{2}$/.test(body.time)) {
    return NextResponse.json({ error: "Time must be HH:MM." }, { status: 400 });
  }

  const service = createServiceClient();
  const timeZone = await getUserTimezone(userId, service);

  const [hour, minute] = body.time.split(":").map(Number);
  const scheduledAt = instantForLocalTime(body.date, hour, minute, timeZone);

  const result = await bookCall(service, {
    userId,
    contactId: body.contactId,
    scheduledAt,
    note: body.note ?? null,
    brokerTimezone: timeZone,
    replace: body.replace === true,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({ callId: result.callId, zone: result.zone });
}
