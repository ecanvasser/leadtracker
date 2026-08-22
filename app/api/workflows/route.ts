/**
 * Listing and creating workflows.
 *
 * Writes go through the service client after an explicit ownership check
 * rather than relying on RLS alone — the same pattern the rest of the app
 * uses, and it keeps the failure mode "403" rather than "row silently not
 * inserted".
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { validateWorkflow } from "@/lib/workflows/validate";

export async function GET() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = authData.claims.sub as string;
  const service = createServiceClient();

  const { data: workflows, error } = await service
    .from("workflows")
    .select("*")
    .eq("user_id", userId)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Recent runs for every workflow in one query rather than N. 4.5 asks for
  // run history per workflow, and the list page shows a count plus the latest
  // few without a second round-trip per row.
  const ids = (workflows ?? []).map((w) => w.id);
  const runs = ids.length
    ? (
        await service
          .from("workflow_runs")
          .select("*")
          .in("workflow_id", ids)
          .order("fired_at", { ascending: false })
          .limit(200)
      ).data ?? []
    : [];

  const { data: settings } = await service
    .from("user_settings")
    .select("workflows_enabled")
    .eq("user_id", userId)
    .maybeSingle();

  return NextResponse.json({
    workflows: workflows ?? [],
    runs,
    // The kill switch state belongs with the list: a page full of "live"
    // badges is a lie if evaluation is globally paused.
    workflowsEnabled: settings?.workflows_enabled ?? true,
  });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = authData.claims.sub as string;

  const body = await request.json().catch(() => null);
  const invalid = validateWorkflow(body);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  const b = body as Record<string, unknown>;
  const service = createServiceClient();

  const { data, error } = await service
    .from("workflows")
    .insert({
      user_id: userId,
      name: (b.name as string).trim(),
      // 4.4: dry-run is not optional. A new workflow is off and in dry-run
      // whatever the client sent, and Eddie changes that from the list.
      enabled: false,
      dry_run: true,
      trigger_type: b.trigger_type,
      trigger_config: b.trigger_config ?? {},
      conditions: b.conditions ?? {},
      action_type: b.action_type,
      action_config: b.action_config ?? {},
      requires_approval: b.requires_approval ?? true,
      priority: b.priority ?? 100,
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ workflow: data });
}
