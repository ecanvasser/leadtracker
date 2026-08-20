import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { searchProspectByEmail, getMortgageFields } from "@/lib/bonzo/client";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { email } = await request.json();
  if (!email || typeof email !== "string") {
    return NextResponse.json({ error: "Email required" }, { status: 400 });
  }

  try {
    const prospect = await searchProspectByEmail(email.trim());
    if (!prospect) {
      return NextResponse.json({ found: false });
    }

    const name =
      [prospect.first_name, prospect.last_name].filter(Boolean).join(" ") ||
      prospect.full_name ||
      "";

    // `prospect` carries the complete Bonzo record, including the mortgage
    // sub-object. The caller writes this straight into insights_cache, so
    // there is no second lookup and nothing gets dropped on the way through.
    return NextResponse.json({
      found: true,
      prospect: {
        id: prospect.id,
        name,
        email: prospect.email,
        phone: prospect.phone,
      },
      fullProspect: prospect,
      hasMortgageFields: getMortgageFields(prospect) !== null,
    });
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "Failed to search Bonzo";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
