import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  planLead,
  type LeadPlan,
  type QueueAction,
  type OutreachLogEntry,
  type BonzoCommEntry,
} from "@/lib/cadence/engine";
import { resolveCadenceConfig, type CadenceConfig } from "@/lib/cadence/config";
import type { LeadState } from "@/lib/insights/lead-state";
import { Contact, QUEUE_ELIGIBLE_STAGES } from "@/types/db";
import { getUserTimezone, localDate } from "@/lib/time";

/**
 * Phase 7 retirement: drafting is gone. The queue still decides who to work
 * and why; it no longer writes the message. These two shapes travelled with
 * the drafting module, so they live here now — the only place left that reads
 * the insights cache to build a queue row.
 */
export interface InsightsCache {
  contact_id: string;
  bonzo_prospect_data: Record<string, unknown>;
  bonzo_communication: BonzoCommEntry[];
  ai_analysis: Record<string, unknown>;
  lead_state: LeadState | null;
}

export interface PendingAction {
  contact: Contact;
  action: QueueAction;
  plan: LeadPlan;
  cache: InsightsCache;
}

function buildDecisionTrace(input: {
  action: QueueAction;
  plan: LeadPlan;
  leadState: LeadState | null;
  cadenceConfig: CadenceConfig;
  timeZone: string;
}): Record<string, unknown> {
  const { action, plan, leadState, cadenceConfig, timeZone } = input;

  return {
    // Which lane and which rule inside it.
    lane: action.lane,
    rule_fired: plan.inputs.rule ?? null,
    lead_age_days: plan.ageDays,

    // The priority arithmetic, so a surprising rank can be traced.
    priority: {
      score: action.priorityScore,
      reason: action.priorityReason,
      base_score: plan.inputs.base_score ?? null,
      is_overdue: plan.inputs.is_overdue ?? false,
      target_messages: plan.inputs.target_messages ?? null,
      target_calls: plan.inputs.target_calls ?? null,
    },

    // What the classifier believed, and what it could prove.
    lead_state: leadState
      ? {
          lead_temp: leadState.lead_temp,
          blocker: leadState.blocker,
          blocker_confidence: leadState.blocker_confidence,
          blocker_evidence: leadState.blocker_evidence,
          why_now: leadState.why_now,
          recommended_action: leadState.recommended_action,
        }
      : null,

    // Raw engine inputs, verbatim.
    inputs: plan.inputs,

    // The cadence constants in force at generation time — a trace read weeks
    // later is misleading if the settings have since changed.
    cadence_config: cadenceConfig,
    timezone: timeZone,

    generated_at: new Date().toISOString(),
  };
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = authData.claims.sub as string;
  const serviceClient = createServiceClient();

  // "Today" is the broker's local day, resolved once and reused everywhere
  // below. Computing it per-query with toISOString() rolled the queue over at
  // 5 PM Pacific and silently discarded the afternoon block.
  const timeZone = await getUserTimezone(userId, serviceClient);
  const todayStr = localDate(new Date(), timeZone);

  const { data: userSettings } = await serviceClient
    .from("user_settings")
    .select("cadence_config")
    .eq("user_id", userId)
    .maybeSingle();

  const cadenceConfig: CadenceConfig = resolveCadenceConfig(
    userSettings?.cadence_config
  );

  const { data: existingQueue } = await serviceClient
    .from("daily_queue")
    .select("created_at")
    .eq("user_id", userId)
    .eq("queue_date", todayStr)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingQueue) {
    const lastGen = new Date(existingQueue.created_at).getTime();
    const fifteenMin = 15 * 60 * 1000;
    if (Date.now() - lastGen < fifteenMin) {
      const body = await request.json().catch(() => ({}));
      if (!body.force) {
        return NextResponse.json(
          { error: "Queue was generated less than 15 minutes ago. Pass force: true to override." },
          { status: 429 }
        );
      }
    }
  }

  const { data: contacts } = await serviceClient
    .from("contacts")
    .select("*")
    .eq("user_id", userId)
    .eq("insights_enabled", true)
    // Membership, not equality. QUEUE_ELIGIBLE_STAGES is the single definition
    // of "a lead the engine works"; a bare comparison here is how a new stage
    // silently drops out of the queue.
    .in("stage", [...QUEUE_ELIGIBLE_STAGES]);

  if (!contacts || contacts.length === 0) {
    return NextResponse.json({ queue: [], generated: true });
  }

  const contactIds = contacts.map((c) => c.id);

  const [{ data: outreachData }, { data: insightsData }] = await Promise.all([
    serviceClient
      .from("outreach_log")
      .select("*")
      .in("contact_id", contactIds)
      .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .order("created_at", { ascending: true }),
    serviceClient
      .from("insights_cache")
      .select("contact_id, bonzo_prospect_data, bonzo_communication, ai_analysis, lead_state")
      .in("contact_id", contactIds),
  ]);

  const outreachByContact: Record<string, OutreachLogEntry[]> = {};
  for (const entry of (outreachData ?? []) as OutreachLogEntry[]) {
    if (!outreachByContact[entry.contact_id]) outreachByContact[entry.contact_id] = [];
    outreachByContact[entry.contact_id].push(entry);
  }

  const insightsByContact: Record<string, InsightsCache> = {};
  for (const cache of (insightsData ?? []) as InsightsCache[]) {
    insightsByContact[cache.contact_id] = cache;
  }

  // 0.6: today's already-actioned rows are load-bearing. handleGenerate(true)
  // used to delete every row for today and reinsert everything as pending,
  // wiping the progress bar, sent counts and skips.
  const { data: existingRows } = await serviceClient
    .from("daily_queue")
    .select("id, contact_id, action_type, status, priority_rank")
    .eq("user_id", userId)
    .eq("queue_date", todayStr);

  const actionedRows = (existingRows ?? []).filter((r) => r.status !== "pending");

  // How many actions of each kind are already spoken for today, so a refresh
  // cannot resurrect something already sent, skipped or marked done.
  const actionedCount = new Map<string, number>();
  for (const row of actionedRows) {
    const key = `${row.contact_id}:${row.action_type}`;
    actionedCount.set(key, (actionedCount.get(key) ?? 0) + 1);
  }

  const allActions: PendingAction[] = [];
  /** Leads the engine deliberately stayed quiet on, surfaced in the response. */
  const held: { contactId: string; name: string; reason: string; recommendAdverse: boolean }[] = [];

  // 3.3 — a confirmed call suppresses other outreach to that lead until it
  // resolves. Texting someone an hour before a call you already booked is
  // exactly the kind of thing that makes an assistant feel automated.
  const suppressedByCall = new Set<string>();
  {
    const now = Date.now();
    const { data: upcoming } = await serviceClient
      .from("scheduled_calls")
      .select("contact_id")
      .eq("user_id", userId)
      .eq("status", "confirmed")
      .gte("scheduled_at", new Date(now - 2 * 60 * 60 * 1000).toISOString())
      .lte("scheduled_at", new Date(now + 24 * 60 * 60 * 1000).toISOString());

    for (const row of upcoming ?? []) suppressedByCall.add(row.contact_id);
  }

  for (const contact of contacts as Contact[]) {
    if (suppressedByCall.has(contact.id)) {
      held.push({
        contactId: contact.id,
        name: contact.name,
        reason: "Call scheduled — holding other outreach until it resolves",
        recommendAdverse: false,
      });
      continue;
    }

    const history = outreachByContact[contact.id] ?? [];
    const cache = insightsByContact[contact.id];
    const comms = cache?.bonzo_communication ?? [];

    const plan = planLead(contact, history, comms, {
      timeZone,
      config: cadenceConfig,
      leadState: cache?.lead_state ?? null,
    });

    if (plan.hold) {
      held.push({
        contactId: contact.id,
        name: contact.name,
        reason: plan.holdReason ?? "No action due",
        recommendAdverse: plan.recommendAdverse,
      });
    }

    for (const action of plan.actions) {
      // Drop this action if an equivalent one was already actioned today.
      const key = `${contact.id}:${action.actionType}`;
      const covered = actionedCount.get(key) ?? 0;
      if (covered > 0) {
        actionedCount.set(key, covered - 1);
        continue;
      }
      allActions.push({
        contact,
        action,
        plan,
        cache: cache ?? {
          contact_id: contact.id,
          bonzo_prospect_data: {},
          bonzo_communication: [],
          ai_analysis: {},
          lead_state: null,
        },
      });
    }
  }

  if (allActions.length === 0) {
    // Clear only what was still pending; anything actioned stays on the board.
    await serviceClient
      .from("daily_queue")
      .delete()
      .eq("user_id", userId)
      .eq("queue_date", todayStr)
      .eq("status", "pending");

    const { data: remaining } = await serviceClient
      .from("daily_queue")
      .select("*, contacts(name, loan_type, crm, stage, created_at, insights_enabled)")
      .eq("user_id", userId)
      .eq("queue_date", todayStr)
      .order("priority_rank", { ascending: true });

    // An empty queue with no explanation is indistinguishable from a broken
    // one. When the engine deliberately stayed quiet on every lead, say so and
    // say why — that is the whole point of allowing it to do nothing.
    return NextResponse.json({ queue: remaining ?? [], generated: true, held });
  }

  allActions.sort((a, b) => {
    if (b.action.priorityScore !== a.action.priorityScore) {
      return b.action.priorityScore - a.action.priorityScore;
    }
    return new Date(a.contact.created_at).getTime() - new Date(b.contact.created_at).getTime();
  });

  // Only pending rows are replaced. Actioned rows are left exactly as they are.
  await serviceClient
    .from("daily_queue")
    .delete()
    .eq("user_id", userId)
    .eq("queue_date", todayStr)
    .eq("status", "pending");

  // New rows rank after everything already actioned, so the progress bar keeps
  // counting up rather than resetting.
  const rankOffset = actionedRows.length;

  const queueRows = allActions.map(({ contact, action, plan, cache }, idx) => {
    return {
      user_id: userId,
      contact_id: contact.id,
      queue_date: todayStr,
      priority_rank: rankOffset + idx + 1,
      priority_reason: action.priorityReason,
      action_type: action.actionType,
      // draft_message, email_subject and call_talking_points stay in the
      // schema (they hold historical rows) but are no longer written. Phase 7
      // replaces the draft with suggested_angle from the classifier.
      status: "pending",
      lane: action.lane,
      touch_label: action.touchLabel,
      decision_trace: buildDecisionTrace({
        action,
        plan,
        leadState: cache.lead_state,
        cadenceConfig,
        timeZone,
      }),
    };
  });

  const { error: insertErr } = await serviceClient
    .from("daily_queue")
    .insert(queueRows);

  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  const { data: queue } = await serviceClient
    .from("daily_queue")
    .select("*, contacts(name, loan_type, crm, stage, created_at, insights_enabled)")
    .eq("user_id", userId)
    .eq("queue_date", todayStr)
    .order("priority_rank", { ascending: true });

  return NextResponse.json({ queue: queue ?? [], generated: true, held });
}
