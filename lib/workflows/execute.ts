/**
 * Executing a workflow's action (spec 4.3, rollout step 5).
 *
 * Everything here has already survived evaluation. This module's job is the
 * last mile: re-check what changed since, do the one thing, and report what it
 * displaced so it can be undone.
 *
 * Two rules hold throughout:
 *
 *   1. Dry-run never reaches here. The runner does not call executeAction for
 *      a dry_run workflow, and executeAction refuses anyway if it somehow is —
 *      "dry-run makes zero Bonzo calls" is the promise Eddie is trusting when
 *      he watches a workflow for three days, and a single leak makes that
 *      observation worthless.
 *
 *   2. Anything that causes a message re-checks opt-out against a *freshly
 *      read* prospect, not the facts gathered at evaluation time. An opt-out
 *      that arrived in between is exactly the one that matters.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  currentCampaign,
  getProspect,
  isOptedOut,
  moveProspectToCampaign,
} from "@/lib/bonzo/client";
import { createTask } from "@/lib/db/tasks";
import type { Workflow } from "@/lib/workflows/types";
import { causesMessage } from "@/lib/workflows/evaluate";
import type { AdverseReason, AllStages, Contact } from "@/types/db";

export type ActionResult =
  | {
      ok: true;
      summary: string;
      /** What this action replaced, for reversal. Recorded on the run. */
      displaced?: Record<string, unknown> | null;
    }
  | { ok: false; error: string };

export interface ExecuteInput {
  supabase: SupabaseClient;
  workflow: Workflow;
  contact: Contact;
  /** Guard: the runner passes what it planned, and anything but "executed" is a bug. */
  plannedStatus: "dry_run" | "pending_approval" | "executed";
}

export async function executeAction(input: ExecuteInput): Promise<ActionResult> {
  const { supabase, workflow, contact, plannedStatus } = input;

  if (plannedStatus !== "executed") {
    // Defence in depth. The runner already branches on this; if that branch is
    // ever refactored wrong, this refuses rather than quietly messaging a
    // client from a workflow that was supposed to be observing.
    return {
      ok: false,
      error: `refused: executeAction called with plannedStatus=${plannedStatus}`,
    };
  }

  const cfg = workflow.action_config ?? {};

  try {
    switch (workflow.action_type) {
      case "notify_telegram": {
        // Deliberately first in the rollout: it messages Eddie, never a client.
        const { pushWorkflowNotice } = await import("@/lib/telegram/workflow-card");
        const message = String(cfg.message ?? "").trim();
        if (!message) return { ok: false, error: "no message configured" };
        await pushWorkflowNotice(supabase, contact.user_id, {
          contactName: contact.name,
          contactId: contact.id,
          workflowName: workflow.name,
          message,
        });
        return { ok: true, summary: `notified about ${contact.name}` };
      }

      case "create_task": {
        const title = String(cfg.title ?? "").trim();
        if (!title) return { ok: false, error: "no task title configured" };
        await createTask(supabase, {
          user_id: contact.user_id,
          contact_id: contact.id,
          title,
        });
        return { ok: true, summary: `created task "${title}"` };
      }

      case "move_stage": {
        const stage = cfg.stage as AllStages | undefined;
        if (!stage) return { ok: false, error: "no target stage configured" };

        const { error } = await supabase
          .from("contacts")
          .update({ stage, updated_at: new Date().toISOString() })
          .eq("id", contact.id);
        if (error) return { ok: false, error: error.message };

        return {
          ok: true,
          summary: `moved to ${stage}`,
          displaced: { stage: contact.stage },
        };
      }

      case "mark_adverse": {
        const reason = cfg.reason as AdverseReason | undefined;
        if (!reason) return { ok: false, error: "no adverse reason configured" };

        const { error } = await supabase
          .from("contacts")
          .update({
            stage: "adverse",
            adverse_reason: reason,
            updated_at: new Date().toISOString(),
          })
          .eq("id", contact.id);
        if (error) return { ok: false, error: error.message };

        return {
          ok: true,
          summary: `marked adverse (${reason})`,
          displaced: { stage: contact.stage, adverse_reason: contact.adverse_reason },
        };
      }

      case "queue_follow_up": {
        const { localDate } = await import("@/lib/time");
        const { getUserTimezone } = await import("@/lib/time");
        const tz = await getUserTimezone(contact.user_id, supabase);
        const today = localDate(new Date(), tz);

        const reason = `Workflow: ${workflow.name}`;

        // Idempotent within the day. workflow_runs already stops a re-fire per
        // occurrence; this stops a second card if the same lead is surfaced by
        // a different route on the same day.
        const { data: existing } = await supabase
          .from("daily_queue")
          .select("id")
          .eq("contact_id", contact.id)
          .eq("queue_date", today)
          .eq("priority_reason", reason)
          .maybeSingle();

        if (existing) return { ok: true, summary: "card already queued today" };

        const { error } = await supabase.from("daily_queue").insert({
          user_id: contact.user_id,
          contact_id: contact.id,
          queue_date: today,
          priority_rank: 1,
          priority_reason: reason,
          action_type: "sms",
          status: "pending",
          lane: "workflow",
          decision_trace: {
            lane: "workflow",
            rule_fired: workflow.trigger_type,
            workflow_id: workflow.id,
            workflow_name: workflow.name,
          },
        });
        if (error) return { ok: false, error: error.message };
        return { ok: true, summary: "queued a follow-up card" };
      }

      case "add_to_bonzo_campaign": {
        const campaignId = cfg.campaign_id;
        if (typeof campaignId !== "number") {
          return { ok: false, error: "no campaign configured" };
        }
        if (!contact.bonzo_prospect_id) {
          return { ok: false, error: "contact has no linked Bonzo prospect" };
        }

        /*
         * Read the prospect fresh. Two things depend on it and neither can use
         * evaluation-time facts:
         *
         *   - The opt-out check. 4.4 calls a campaign handoff a send, and the
         *     opt-out that matters is the one that arrived since evaluation.
         *   - The current campaign, which enrolment is about to replace. If it
         *     is not recorded here it cannot be put back.
         */
        const prospect = await getProspect(contact.bonzo_prospect_id);
        if (!prospect) {
          return { ok: false, error: "Bonzo prospect could not be read" };
        }

        if (
          isOptedOut(prospect, "sms") ||
          isOptedOut(prospect, "email") ||
          prospect.do_not_call === true
        ) {
          return { ok: false, error: "prospect is opted out or DNC; handoff refused" };
        }

        const displacedCampaign = currentCampaign(prospect);

        await moveProspectToCampaign(contact.bonzo_prospect_id, campaignId);

        return {
          ok: true,
          summary: displacedCampaign
            ? `moved to campaign ${campaignId}, replacing ${displacedCampaign.name}`
            : `moved to campaign ${campaignId}`,
          displaced: displacedCampaign
            ? { campaign_id: displacedCampaign.id, campaign_name: displacedCampaign.name }
            : null,
        };
      }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "action failed" };
  }
}

/**
 * Undoes an action from its recorded `displaced` payload.
 *
 * Only campaign moves and stage changes are reversible, which is the honest
 * set: a sent Telegram note cannot be unsent and a created task is Eddie's to
 * delete. Reversal exists because enrolment replaces — a wrong handoff pulls a
 * lead out of a nurture sequence it was in for a reason.
 */
export async function revertAction(input: {
  supabase: SupabaseClient;
  workflow: Pick<Workflow, "action_type">;
  contact: Contact;
  displaced: Record<string, unknown> | null;
}): Promise<ActionResult> {
  const { supabase, workflow, contact, displaced } = input;
  if (!displaced) return { ok: false, error: "nothing recorded to revert to" };

  try {
    if (workflow.action_type === "add_to_bonzo_campaign") {
      const id = displaced.campaign_id;
      if (typeof id !== "number") return { ok: false, error: "no previous campaign recorded" };
      if (!contact.bonzo_prospect_id) return { ok: false, error: "no linked Bonzo prospect" };
      await moveProspectToCampaign(contact.bonzo_prospect_id, id);
      return { ok: true, summary: `restored campaign ${id}` };
    }

    if (workflow.action_type === "move_stage" || workflow.action_type === "mark_adverse") {
      const stage = displaced.stage as AllStages | undefined;
      if (!stage) return { ok: false, error: "no previous stage recorded" };
      const { error } = await supabase
        .from("contacts")
        .update({
          stage,
          adverse_reason: (displaced.adverse_reason as AdverseReason | null) ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", contact.id);
      if (error) return { ok: false, error: error.message };
      return { ok: true, summary: `restored stage ${stage}` };
    }

    return { ok: false, error: `${workflow.action_type} cannot be reverted` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "revert failed" };
  }
}

/** Re-exported so callers do not reach into evaluate.ts for one predicate. */
export { causesMessage };
