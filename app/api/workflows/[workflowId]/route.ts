/**
 * Updating and deleting one workflow.
 *
 * Ownership is checked explicitly before every write. The service client
 * bypasses RLS, so this is the only thing standing between a guessed id and
 * someone else's row — even in a single-user app, because that assumption is
 * exactly the kind that stops being true quietly.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { validateWorkflow } from "@/lib/workflows/validate";

async function authorize(workflowId: string) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) return { error: "Unauthorized", status: 401 as const };

  const userId = authData.claims.sub as string;
  const service = createServiceClient();

  const { data: existing } = await service
    .from("workflows")
    .select("id, user_id")
    .eq("id", workflowId)
    .maybeSingle();

  if (!existing) return { error: "Workflow not found", status: 404 as const };
  if (existing.user_id !== userId) {
    return { error: "Workflow not found", status: 404 as const };
  }
  return { userId, service };
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  const { workflowId } = await params;
  const auth = await authorize(workflowId);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  }

  const b = body as Record<string, unknown>;

  /*
   * A state-only change — the enabled/dry-run/live switch on the list — skips
   * full validation, because it does not touch the fields validation is about
   * and requiring a complete payload to flip a toggle is how a UI ends up
   * sending back a stale copy of everything else.
   */
  const STATE_ONLY = [
    "enabled",
    "dry_run",
    "requires_approval",
    "auto_approve",
    "priority",
  ];
  const keys = Object.keys(b);
  const isStateOnly = keys.length > 0 && keys.every((k) => STATE_ONLY.includes(k));

  if (!isStateOnly) {
    const invalid = validateWorkflow(body);
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
  } else {
    for (const flag of [
      "enabled",
      "dry_run",
      "requires_approval",
      "auto_approve",
    ] as const) {
      if (b[flag] !== undefined && typeof b[flag] !== "boolean") {
        return NextResponse.json({ error: `${flag} must be true or false` }, { status: 400 });
      }
    }
    if (b.priority !== undefined && typeof b.priority !== "number") {
      return NextResponse.json({ error: "priority must be a number" }, { status: 400 });
    }
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const WRITABLE = [
    "name",
    "enabled",
    "dry_run",
    "trigger_type",
    "trigger_config",
    "conditions",
    "action_type",
    "action_config",
    "requires_approval",
    "auto_approve",
    "priority",
  ];
  for (const key of WRITABLE) {
    if (b[key] !== undefined) patch[key] = key === "name" ? String(b[key]).trim() : b[key];
  }

  const { data, error } = await auth.service
    .from("workflows")
    .update(patch)
    .eq("id", workflowId)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ workflow: data });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  const { workflowId } = await params;
  const auth = await authorize(workflowId);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  // workflow_runs cascades. The history goes with the rule that produced it,
  // which is the right call: an orphaned run history names a workflow nobody
  // can look up.
  const { error } = await auth.service.from("workflows").delete().eq("id", workflowId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
