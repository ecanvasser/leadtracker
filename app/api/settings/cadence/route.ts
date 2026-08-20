import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { resolveCadenceConfig } from "@/lib/cadence/config";
import { isValidTimezone, clearTimezoneCache } from "@/lib/time";

export async function PUT(request: NextRequest) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = authData.claims.sub as string;

  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { config, brokerName, brokerCompany, timezone } = body;

  // A bad zone silently breaks every date computation in the app, so it is
  // rejected here with a usable message rather than caught by the database
  // constraint with a Postgres error.
  if (typeof timezone === "string" && !isValidTimezone(timezone)) {
    return NextResponse.json(
      {
        error:
          `"${timezone}" is not a usable timezone. Use a Region/City name such as ` +
          `America/Los_Angeles. Abbreviations like EST map to fixed offsets that ` +
          `ignore daylight saving.`,
      },
      { status: 400 }
    );
  }

  if (typeof brokerName === "string" && !brokerName.trim()) {
    return NextResponse.json(
      { error: "Your name is used in the required opener and cannot be blank" },
      { status: 400 }
    );
  }
  if (typeof brokerCompany === "string" && !brokerCompany.trim()) {
    return NextResponse.json(
      { error: "Company is used in the required opener and cannot be blank" },
      { status: 400 }
    );
  }

  const update: Record<string, unknown> = {};
  // Normalized through the same resolver the engine uses, so a value that
  // would make the engine nonsensical is clamped before it is stored.
  if (config !== undefined) update.cadence_config = resolveCadenceConfig(config);
  if (typeof brokerName === "string") update.broker_display_name = brokerName.trim();
  if (typeof brokerCompany === "string") update.broker_company = brokerCompany.trim();
  if (typeof timezone === "string") update.timezone = timezone;

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const service = createServiceClient();
  const { error } = await service
    .from("user_settings")
    .update(update)
    .eq("user_id", userId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // The timezone is memoised per process; a stale entry would keep computing
  // "today" in the old zone for up to a minute after the change.
  clearTimezoneCache();

  return NextResponse.json({ saved: true, config: update.cadence_config });
}
