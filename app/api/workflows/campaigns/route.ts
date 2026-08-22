/**
 * Bonzo campaigns, for the workflow builder's action dropdown.
 *
 * Read-only. Listing campaigns needs the `campaigns` token scope, which the
 * original API token did not carry — a 403 here means the token, not the
 * account, so it is reported as such rather than as an empty list. An empty
 * dropdown with no explanation is how someone concludes they have no
 * campaigns and starts creating duplicates.
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listCampaigns } from "@/lib/bonzo/client";

export async function GET() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const campaigns = await listCampaigns();
    return NextResponse.json({
      campaigns: campaigns.map((c) => ({
        id: c.id,
        name: c.name,
        prospectsCount: c.prospects_count ?? null,
        // Surfaced because it changes what enrolling means: a campaign with a
        // live sequence starts messaging on enrolment, one without does not.
        sequenceEnabled: c.sequence ? c.sequence.enabled !== false : false,
      })),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to read campaigns";
    const isScope = message.includes("403") || message.toLowerCase().includes("scope");
    return NextResponse.json(
      {
        error: isScope
          ? "Bonzo rejected the request for campaigns. The API token needs the `campaigns` scope."
          : message,
      },
      { status: isScope ? 403 : 502 }
    );
  }
}
