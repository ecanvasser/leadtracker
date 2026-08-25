import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { scheduleTouches } from "@/lib/agents/schedule";
import type { AgentPlan } from "@/lib/agents/types";

type Action = "activate" | "pause" | "resume" | "retire";

/**
 * PATCH /api/agents/:agentId — move an agent along its lifecycle.
 *
 * Every transition is Eddie's, made from the contact page. Nothing here is
 * reachable by a rule or a job: the machine can stop an agent (a reply, a
 * stage change) but only he can start one.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;

  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = authData.claims.sub as string;

  const body = (await request.json().catch(() => null)) as { action?: Action } | null;
  const action = body?.action;
  if (!action || !["activate", "pause", "resume", "retire"].includes(action)) {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const service = createServiceClient();

  const { data: agent } = await service
    .from("contact_agents")
    .select("*")
    .eq("id", agentId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

  const now = new Date();

  if (action === "activate") {
    if (agent.status !== "draft") {
      return NextResponse.json(
        { error: `Only a draft plan can be activated; this one is ${agent.status}.` },
        { status: 409 }
      );
    }

    const plan = (agent.plan ?? { steps: [] }) as AgentPlan;
    if (plan.steps.length === 0) {
      return NextResponse.json({ error: "This plan has no steps" }, { status: 400 });
    }

    /*
     * Touches are written before the status flips.
     *
     * If the order were reversed and the insert failed, the agent would be
     * active with nothing scheduled — a live agent that silently never acts,
     * which is worse than one that failed to start.
     */
    const rows = scheduleTouches(plan, now).map((t) => ({
      agent_id: agent.id,
      user_id: userId,
      contact_id: agent.contact_id,
      step_index: t.step_index,
      due_at: t.due_at,
    }));

    const { error: touchErr } = await service
      .from("contact_agent_touches")
      .upsert(rows, { onConflict: "agent_id,step_index" });

    if (touchErr) {
      return NextResponse.json({ error: touchErr.message }, { status: 500 });
    }

    const { data: updated, error } = await service
      .from("contact_agents")
      .update({ status: "active", activated_at: now.toISOString(), paused_reason: null })
      .eq("id", agent.id)
      .eq("status", "draft")
      .select("*")
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ agent: updated });
  }

  if (action === "pause") {
    const { data: updated, error } = await service
      .from("contact_agents")
      .update({ status: "paused", paused_reason: "Paused by you" })
      .eq("id", agent.id)
      .eq("status", "active")
      .select("*")
      .maybeSingle();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ agent: updated ?? agent });
  }

  if (action === "resume") {
    if (agent.status !== "paused") {
      return NextResponse.json(
        { error: `Only a paused agent can resume; this one is ${agent.status}.` },
        { status: 409 }
      );
    }

    /*
     * Resuming re-schedules from now rather than restoring the original dates.
     *
     * An agent paused for a week would otherwise wake up with three touches
     * already overdue and fire them on consecutive days — the burst the
     * spacing exists to prevent. Steps that already went out stay settled;
     * only what never ran is rescheduled, keeping the original gaps between
     * the remaining steps.
     */
    const plan = (agent.plan ?? { steps: [] }) as AgentPlan;
    const { data: done } = await service
      .from("contact_agent_touches")
      .select("step_index")
      .eq("agent_id", agent.id)
      .in("status", ["sent", "skipped", "drafted"]);

    const settled = new Set((done ?? []).map((d) => d.step_index as number));
    const remaining = plan.steps.filter((s) => !settled.has(s.step));

    if (remaining.length === 0) {
      const { data: updated } = await service
        .from("contact_agents")
        .update({ status: "completed", ended_at: now.toISOString() })
        .eq("id", agent.id)
        .select("*")
        .single();
      return NextResponse.json({ agent: updated });
    }

    const firstDay = remaining[0].day;
    const rows = remaining.map((s) => ({
      agent_id: agent.id,
      user_id: userId,
      contact_id: agent.contact_id,
      step_index: s.step,
      // Rebased so the next step is due now and the rest keep their spacing.
      due_at: new Date(now.getTime() + (s.day - firstDay) * 86_400_000).toISOString(),
      status: "pending",
      note: null,
      settled_at: null,
    }));

    const { error: touchErr } = await service
      .from("contact_agent_touches")
      .upsert(rows, { onConflict: "agent_id,step_index" });

    if (touchErr) {
      return NextResponse.json({ error: touchErr.message }, { status: 500 });
    }

    const { data: updated, error } = await service
      .from("contact_agents")
      .update({ status: "active", paused_reason: null })
      .eq("id", agent.id)
      .select("*")
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ agent: updated });
  }

  // retire
  await service
    .from("contact_agent_touches")
    .update({
      status: "cancelled",
      note: "cancelled: agent retired",
      settled_at: now.toISOString(),
    })
    .eq("agent_id", agent.id)
    .eq("status", "pending");

  const { data: updated, error } = await service
    .from("contact_agents")
    .update({
      status: "retired",
      paused_reason: "Retired by you",
      ended_at: now.toISOString(),
    })
    .eq("id", agent.id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ agent: updated });
}
