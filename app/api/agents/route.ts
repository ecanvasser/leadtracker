import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { buildPlan } from "@/lib/agents/plan";
import { isLiveAgent, type AgentStatus } from "@/lib/agents/types";
import { recordModelUsage, withinBudget } from "@/lib/ai/usage";
import { getCommunicationHistory, getProspect } from "@/lib/bonzo/client";
import type { LeadState } from "@/lib/insights/lead-state";

/** The brief is the whole safety argument. Too short is not a brief. */
const MIN_CONTEXT_CHARS = 20;
const MAX_CONTEXT_CHARS = 4000;

/**
 * GET /api/agents?contactId=… — the live agent for a lead, plus its touches.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contactId = request.nextUrl.searchParams.get("contactId");
  if (!contactId) {
    return NextResponse.json({ error: "contactId is required" }, { status: 400 });
  }

  const { data: agent } = await supabase
    .from("contact_agents")
    .select("*")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!agent) return NextResponse.json({ agent: null, touches: [] });

  const { data: touches } = await supabase
    .from("contact_agent_touches")
    .select("*")
    .eq("agent_id", agent.id)
    .order("step_index", { ascending: true });

  return NextResponse.json({ agent, touches: touches ?? [] });
}

/**
 * POST /api/agents — build a plan for one lead.
 *
 * Creates the agent in `draft`: the plan is shown to Eddie and does nothing
 * until he activates it. That gap is the point. A plan he has not read is a
 * sequence of messages to a client that nobody approved.
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
    context?: string;
    goal?: string;
    durationDays?: number;
  } | null;

  if (!body?.contactId) {
    return NextResponse.json({ error: "contactId is required" }, { status: 400 });
  }

  const context = (body.context ?? "").trim();
  const goal = (body.goal ?? "").trim();

  /*
   * Rejected rather than defaulted.
   *
   * This feature drafts outside the quoted window, which Phase 8 forbade, and
   * the only thing that makes it safe is that a person wrote down what they
   * know about this lead first. A blank brief is precisely the retired
   * system — a model writing to someone it knows nothing about — so it is
   * refused here as well as by a NOT NULL constraint.
   */
  if (context.length < MIN_CONTEXT_CHARS) {
    return NextResponse.json(
      {
        error:
          "Tell the agent what you know about this lead — at least a sentence. " +
          "That context is the only reason it can write to them at all.",
      },
      { status: 400 }
    );
  }
  if (context.length > MAX_CONTEXT_CHARS) {
    return NextResponse.json({ error: "That brief is too long" }, { status: 400 });
  }
  if (!goal) {
    return NextResponse.json(
      { error: "Say what you want to happen" },
      { status: 400 }
    );
  }

  const durationDays = Math.min(Math.max(Number(body.durationDays) || 14, 1), 90);

  const { data: contact } = await supabase
    .from("contacts")
    .select("id, user_id, name, loan_type, stage, bonzo_prospect_id")
    .eq("id", body.contactId)
    .maybeSingle();

  if (!contact) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  if (!contact.bonzo_prospect_id) {
    return NextResponse.json(
      { error: "Link this lead to Bonzo first — an agent needs the conversation." },
      { status: 400 }
    );
  }

  const service = createServiceClient();

  // One live agent per contact, enforced by a partial unique index. Checked
  // here too so the failure is a sentence rather than a constraint violation.
  const { data: existing } = await service
    .from("contact_agents")
    .select("id, status")
    .eq("contact_id", contact.id)
    .in("status", ["draft", "active", "paused"])
    .maybeSingle();

  if (existing) {
    return NextResponse.json(
      {
        error: `This lead already has an agent (${existing.status}). End it before deploying another.`,
      },
      { status: 409 }
    );
  }

  const budget = await withinBudget(service, userId);
  if (!budget.ok) {
    return NextResponse.json(
      { error: "Today's token budget is spent. Raise it in Settings or try tomorrow." },
      { status: 429 }
    );
  }

  // Read Bonzo fresh rather than from the cache. Eddie is standing at the
  // screen having just decided this lead needs a plan; the fifteen-minute-old
  // version of the conversation is not good enough to plan a fortnight from.
  const [communications, prospect] = await Promise.all([
    getCommunicationHistory(contact.bonzo_prospect_id),
    getProspect(contact.bonzo_prospect_id),
  ]);

  const { data: cache } = await service
    .from("insights_cache")
    .select("lead_state")
    .eq("contact_id", contact.id)
    .maybeSingle();

  let built;
  try {
    built = await buildPlan({
      contactName: contact.name,
      loanType: contact.loan_type,
      stage: contact.stage,
      context,
      goal,
      durationDays,
      prospect,
      communications,
      leadState: (cache?.lead_state as LeadState | null) ?? null,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not build a plan" },
      { status: 502 }
    );
  }

  await recordModelUsage(
    service,
    { userId, purpose: "analyze", contactId: contact.id },
    built.usage
  );

  const { data: agent, error } = await service
    .from("contact_agents")
    .insert({
      user_id: userId,
      contact_id: contact.id,
      status: "draft" satisfies AgentStatus,
      context,
      goal,
      plan: built.plan,
      duration_days: durationDays,
    })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ agent, live: isLiveAgent(agent.status) });
}
