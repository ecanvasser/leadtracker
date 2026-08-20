/**
 * Reading and writing user_settings.
 *
 * Every field here changes behaviour the broker cannot otherwise see: the
 * timezone decides what "today" means, quiet hours decide when the bot is
 * allowed to interrupt, and cadence_config decides how often anyone is
 * contacted. Validation is strict for that reason — a bad timezone string
 * silently shifts every date computation in the app.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { isValidTimezone, clearTimezoneCache } from "@/lib/time";
import { DEFAULT_CADENCE_CONFIG } from "@/lib/cadence/config";

/** Fields the Settings page may write. */
const WRITABLE = [
  "timezone",
  "broker_display_name",
  "broker_company",
  "morning_digest_time",
  "quiet_hours_start",
  "quiet_hours_end",
  "working_hours_start",
  "working_hours_end",
  "daily_token_budget",
  "cadence_config",
] as const;

type WritableField = (typeof WRITABLE)[number];

export async function GET() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = authData.claims.sub as string;
  const service = createServiceClient();

  const { data } = await service
    .from("user_settings")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  return NextResponse.json({
    settings: data ?? null,
    defaults: { cadence_config: DEFAULT_CADENCE_CONFIG },
  });
}

export async function PATCH(request: NextRequest) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = authData.claims.sub as string;
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  if (!body) {
    return NextResponse.json({ error: "Body required" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  const problems: string[] = [];

  for (const field of WRITABLE) {
    if (!(field in body)) continue;
    const value = body[field];
    const problem = validateField(field, value);
    if (problem) problems.push(problem);
    else update[field] = value;
  }

  if (problems.length > 0) {
    return NextResponse.json({ error: problems.join("; ") }, { status: 400 });
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const service = createServiceClient();
  const { data, error } = await service
    .from("user_settings")
    .update(update)
    .eq("user_id", userId)
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // The timezone is cached per user for the life of the process; a stale entry
  // would keep computing "today" in the old zone until the cache expired.
  if ("timezone" in update) clearTimezoneCache();

  return NextResponse.json({ settings: data });
}

export function validateField(
  field: WritableField,
  value: unknown
): string | null {
  switch (field) {
    case "timezone":
      if (typeof value !== "string" || !isValidTimezone(value)) {
        return `"${String(value)}" is not a valid IANA timezone`;
      }
      return null;

    case "broker_display_name":
    case "broker_company":
      if (typeof value !== "string" || !value.trim()) {
        return `${field.replace(/_/g, " ")} cannot be empty`;
      }
      if (value.length > 120) return `${field.replace(/_/g, " ")} is too long`;
      return null;

    case "morning_digest_time":
    case "quiet_hours_start":
    case "quiet_hours_end":
    case "working_hours_start":
    case "working_hours_end":
      if (typeof value !== "string" || !/^\d{2}:\d{2}(:\d{2})?$/.test(value)) {
        return `${field.replace(/_/g, " ")} must be a time like 08:00`;
      }
      return null;

    case "daily_token_budget": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 10_000) {
        // Below this the budget would halt drafting almost immediately, which
        // looks like the app being broken rather than a budget being enforced.
        return "Daily token budget must be a whole number of at least 10,000";
      }
      return null;
    }

    case "cadence_config":
      return validateCadenceConfig(value);

    default:
      return `Unknown field ${field}`;
  }
}

/** Checks a cadence config against the shape the engine reads. */
export function validateCadenceConfig(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "Cadence config must be an object";
  }

  const cfg = value as Record<string, unknown>;
  const booleans = ["work_sunday", "work_saturday", "saturday_calls"];
  const numbers = [
    "saturday_max_messages",
    "unresponsive_max_consecutive",
    "blocked_min_days_between_touches",
    "in_market_max_age_days",
  ];

  for (const key of booleans) {
    if (key in cfg && typeof cfg[key] !== "boolean") {
      return `${key} must be true or false`;
    }
  }

  for (const key of numbers) {
    if (!(key in cfg)) continue;
    const n = Number(cfg[key]);
    if (!Number.isInteger(n) || n < 0) return `${key} must be a whole number`;
    if (key === "in_market_max_age_days" && (n < 1 || n > 365)) {
      return "in_market_max_age_days must be between 1 and 365";
    }
    if (key === "unresponsive_max_consecutive" && (n < 1 || n > 20)) {
      return "unresponsive_max_consecutive must be between 1 and 20";
    }
  }

  return null;
}
