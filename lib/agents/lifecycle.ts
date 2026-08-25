/**
 * What stops an agent, and how Eddie finds out.
 *
 * An agent that keeps running after the situation changed is the failure this
 * feature has to avoid most: it is the only part of the app that will keep
 * proposing messages to someone days after Eddie last thought about them. So
 * every ending is explicit, carries a reason he can read, and reaches his
 * phone.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { TERMINAL_STAGES, STAGE_LABELS, type AllStages } from "@/types/db";
import type { AgentPlan } from "@/lib/agents/types";

async function notify(
  supabase: SupabaseClient,
  userId: string,
  text: string
): Promise<void> {
  try {
    const [{ createBot }, { getTelegramLink }] = await Promise.all([
      import("@/lib/telegram/bot"),
      import("@/lib/db/telegram"),
    ]);
    const link = await getTelegramLink(supabase, userId);
    if (!link) return;
    await createBot().api.sendMessage(link.telegram_user_id, text);
  } catch (e) {
    // A missed notification must not fail the refresh that noticed the reply.
    console.error("[agents/lifecycle] notify failed:", e);
  }
}

/** Cancels every touch that has not gone out yet. */
async function cancelPendingTouches(
  supabase: SupabaseClient,
  agentId: string,
  note: string
): Promise<number> {
  const { data } = await supabase
    .from("contact_agent_touches")
    .update({ status: "cancelled", note, settled_at: new Date().toISOString() })
    .eq("agent_id", agentId)
    .eq("status", "pending")
    .select("id");
  return (data ?? []).length;
}

/**
 * A reply pauses the agent.
 *
 * Paused rather than retired, because a reply is usually the point — Eddie
 * deployed this to get one. He may well want the rest of the sequence back if
 * the conversation stalls again, and rebuilding a plan costs another model
 * call to reach roughly the same place.
 *
 * The lead becomes his move on the Today screen by the ordinary rules, so this
 * does not need to surface it; it only needs to stop the machine and say so.
 */
export async function pauseAgentOnReply(
  supabase: SupabaseClient,
  contactId: string
): Promise<{ paused: boolean }> {
  const { data: agent } = await supabase
    .from("contact_agents")
    .select("id, user_id, status, contact_id")
    .eq("contact_id", contactId)
    .eq("status", "active")
    .maybeSingle();

  if (!agent) return { paused: false };

  await supabase
    .from("contact_agents")
    .update({
      status: "paused",
      paused_reason: "They replied — the conversation is yours",
    })
    .eq("id", agent.id)
    .eq("status", "active");

  const cancelled = await cancelPendingTouches(
    supabase,
    agent.id as string,
    "cancelled: they replied"
  );

  const { data: contact } = await supabase
    .from("contacts")
    .select("name")
    .eq("id", contactId)
    .maybeSingle();

  await notify(
    supabase,
    agent.user_id as string,
    `🗣 ${contact?.name ?? "A lead"} replied — agent paused.\n\n` +
      `${cancelled} remaining touch${cancelled === 1 ? "" : "es"} cancelled. ` +
      `They're in Your move on Today. Resume the agent from the contact page if it goes quiet again.`
  );

  return { paused: true };
}

/**
 * A stage change ends or pauses the agent.
 *
 * Retired for a terminal stage: the deal is dead or funded and there is
 * nothing to follow up. Paused for anything else, because a lead moving
 * forward is exactly when a planned sequence about the old situation becomes
 * wrong, but not when Eddie wants the plan deleted.
 */
export async function handleAgentStageChange(
  supabase: SupabaseClient,
  contactId: string,
  toStage: AllStages
): Promise<{ ended: boolean }> {
  const { data: agent } = await supabase
    .from("contact_agents")
    .select("id, user_id, status")
    .eq("contact_id", contactId)
    .in("status", ["active", "paused"])
    .maybeSingle();

  if (!agent) return { ended: false };

  const terminal = (TERMINAL_STAGES as readonly string[]).includes(toStage);
  const label = STAGE_LABELS[toStage] ?? toStage;

  await supabase
    .from("contact_agents")
    .update(
      terminal
        ? {
            status: "retired",
            paused_reason: `Moved to ${label}`,
            ended_at: new Date().toISOString(),
          }
        : { status: "paused", paused_reason: `Moved to ${label}` }
    )
    .eq("id", agent.id);

  const cancelled = await cancelPendingTouches(
    supabase,
    agent.id as string,
    `cancelled: moved to ${label}`
  );

  const { data: contact } = await supabase
    .from("contacts")
    .select("name")
    .eq("id", contactId)
    .maybeSingle();

  await notify(
    supabase,
    agent.user_id as string,
    `${terminal ? "🏁" : "⏸"} ${contact?.name ?? "A lead"} moved to ${label} — agent ` +
      `${terminal ? "retired" : "paused"}.\n\n` +
      `${cancelled} remaining touch${cancelled === 1 ? "" : "es"} cancelled.`
  );

  return { ended: true };
}

/**
 * Settles the agent touch behind a queue card, if there is one.
 *
 * Called from every terminal card action. A card that came from an agent has
 * to close its touch, or the agent waits forever on a step Eddie already dealt
 * with and never reports finishing.
 */
export async function settleTouchForQueueItem(
  supabase: SupabaseClient,
  queueItemId: string,
  outcome: "sent" | "skipped"
): Promise<void> {
  const { data: touch } = await supabase
    .from("contact_agent_touches")
    .select("id, agent_id")
    .eq("queue_item_id", queueItemId)
    .maybeSingle();

  if (!touch) return;

  await supabase
    .from("contact_agent_touches")
    .update({ status: outcome, settled_at: new Date().toISOString() })
    .eq("id", touch.id)
    .eq("status", "drafted");

  await completeAgentIfDone(supabase, touch.agent_id as string).catch((e) =>
    console.error("[agents/lifecycle] completion check failed:", e)
  );
}

/**
 * Marks an agent complete once nothing is left to do.
 *
 * Called after a touch settles rather than on a schedule. "Nothing pending and
 * nothing waiting on the phone" is the only honest definition of finished: a
 * drafted touch is still live work until Eddie sends or dismisses it.
 */
export async function completeAgentIfDone(
  supabase: SupabaseClient,
  agentId: string
): Promise<{ completed: boolean }> {
  const { data: agent } = await supabase
    .from("contact_agents")
    .select("id, user_id, status, goal, plan, contact_id")
    .eq("id", agentId)
    .eq("status", "active")
    .maybeSingle();

  if (!agent) return { completed: false };

  const { data: outstanding } = await supabase
    .from("contact_agent_touches")
    .select("id")
    .eq("agent_id", agentId)
    .in("status", ["pending", "drafted"])
    .limit(1);

  if ((outstanding ?? []).length > 0) return { completed: false };

  await supabase
    .from("contact_agents")
    .update({ status: "completed", ended_at: new Date().toISOString() })
    .eq("id", agentId)
    .eq("status", "active");

  const { data: sent } = await supabase
    .from("contact_agent_touches")
    .select("id")
    .eq("agent_id", agentId)
    .eq("status", "sent");

  const { data: contact } = await supabase
    .from("contacts")
    .select("name")
    .eq("id", agent.contact_id as string)
    .maybeSingle();

  const plan = (agent.plan ?? { steps: [] }) as AgentPlan;
  const sentCount = (sent ?? []).length;

  /*
   * The completion note says what happened and what it means, rather than just
   * announcing an end state. A sequence that ran out with no reply is a real
   * answer about the lead, and the recommendation is the part Eddie can act
   * on without opening anything.
   */
  await notify(
    supabase,
    agent.user_id as string,
    `✅ Agent finished for ${contact?.name ?? "a lead"}.\n\n` +
      `Goal: ${agent.goal}\n` +
      `${sentCount} of ${plan.steps.length} planned touches sent, no reply.\n\n` +
      `Three angles tried and nothing back — this one is better handed to a ` +
      `nurture campaign than worked by hand. Their card is on the board.`
  );

  return { completed: true };
}
