/**
 * Trigger matching, and the occurrence identity that makes idempotency real.
 *
 * Each trigger answers two questions: does it fire right now, and *which
 * occasion* is it firing on. The second matters as much as the first. 4.4 says
 * a workflow fires at most once per contact per trigger occurrence, and
 * without a stable identity for "occurrence" a no_inbound_since rule would
 * fire again on every evaluation for the same quiet spell — handing the same
 * lead to a campaign every fifteen minutes.
 *
 * The keys are all derived from observed facts rather than from wall-clock
 * time, so re-evaluating the same unchanged lead produces the same key and the
 * unique index on workflow_runs rejects the duplicate.
 */

import type { LeadFacts, TriggerConfig, TriggerType, Workflow } from "@/lib/workflows/types";

export interface TriggerMatch {
  matched: boolean;
  /** Stable identity of the occasion this fired on. Empty when not matched. */
  occurrenceKey: string;
  /** Facts the decision was made from, recorded on the run for auditing. */
  snapshot: Record<string, unknown>;
  /** Why it did not match, for dry-run output and debugging. */
  reason?: string;
}

const NO_MATCH = (reason: string): TriggerMatch => ({
  matched: false,
  occurrenceKey: "",
  snapshot: {},
  reason,
});

/** Whole days between an ISO timestamp and now. Null when the input is unusable. */
export function daysSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((now.getTime() - t) / 86_400_000);
}

/**
 * The later of two timestamps, ignoring nulls.
 *
 * "Gone quiet for n days" means quiet *since the thing that started the
 * clock*, not since some older event. A lead who replied on Monday and was
 * pitched on Thursday has not been quiet for three days — they have been quiet
 * since Thursday, and they have not had a chance to answer the number yet.
 *
 * Measuring from the earlier of the two would fire the 2-day handoff the
 * instant a lead was pitched, dropping a live deal into a cold campaign before
 * it had a chance to reply. That is the single worst thing this system can do,
 * so the clock always starts at the later event.
 */
function laterOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (!Number.isFinite(ta)) return b;
  if (!Number.isFinite(tb)) return a;
  return ta >= tb ? a : b;
}

/**
 * Short, stable stand-in for "never happened".
 *
 * Distinct from a timestamp so a lead who has never replied gets one
 * occurrence for the whole of that state rather than a new one each day.
 */
const NEVER = "never";

export function matchTrigger(
  workflow: Pick<Workflow, "trigger_type" | "trigger_config">,
  facts: LeadFacts,
  now: Date
): TriggerMatch {
  const cfg: TriggerConfig = workflow.trigger_config ?? {};
  const type: TriggerType = workflow.trigger_type;

  switch (type) {
    /*
     * n days in a given stage.
     *
     * The occurrence is the stage entry, not the day the threshold was
     * crossed — otherwise the rule re-fires every subsequent day, since the
     * lead is still n-or-more days into the stage tomorrow.
     */
    case "days_in_stage": {
      const want = cfg.days;
      if (typeof want !== "number") return NO_MATCH("trigger_config.days missing");
      if (cfg.stage && facts.stage !== cfg.stage) {
        return NO_MATCH(`stage is ${facts.stage}, not ${cfg.stage}`);
      }
      if (!facts.stageChangedAt) return NO_MATCH("stage entry time unknown");

      const elapsed = daysSince(facts.stageChangedAt, now);
      if (elapsed === null) return NO_MATCH("stage entry time unreadable");
      if (elapsed < want) return NO_MATCH(`${elapsed}d in stage, needs ${want}d`);

      return {
        matched: true,
        occurrenceKey: `days_in_stage:${facts.stage}:${facts.stageChangedAt}:${want}`,
        snapshot: { stage: facts.stage, stage_changed_at: facts.stageChangedAt, days_in_stage: elapsed, threshold: want },
      };
    }

    /*
     * n days since their last reply. This is the 2-day rule.
     *
     * A lead who has never replied still qualifies — arguably the clearest
     * case of going quiet — but the clock then runs from when they entered the
     * stage rather than from a reply that never happened.
     */
    case "no_inbound_since": {
      const want = cfg.days;
      if (typeof want !== "number") return NO_MATCH("trigger_config.days missing");

      // The later of their last reply and entering the stage. See laterOf().
      const from = laterOf(facts.lastInboundAt, facts.stageChangedAt);
      if (!from) return NO_MATCH("no inbound and no stage entry time to measure from");

      const elapsed = daysSince(from, now);
      if (elapsed === null) return NO_MATCH("timestamp unreadable");
      if (elapsed < want) return NO_MATCH(`${elapsed}d since inbound, needs ${want}d`);

      return {
        matched: true,
        occurrenceKey: `no_inbound_since:${from}:${want}`,
        snapshot: {
          last_inbound_at: facts.lastInboundAt,
          measured_from: from,
          days_since_inbound: elapsed,
          threshold: want,
        },
      };
    }

    /** n days since Eddie last messaged them. */
    case "no_outbound_since": {
      const want = cfg.days;
      if (typeof want !== "number") return NO_MATCH("trigger_config.days missing");

      const from = laterOf(facts.lastOutboundAt, facts.stageChangedAt);
      if (!from) return NO_MATCH("no outbound and no stage entry time to measure from");

      const elapsed = daysSince(from, now);
      if (elapsed === null) return NO_MATCH("timestamp unreadable");
      if (elapsed < want) return NO_MATCH(`${elapsed}d since outbound, needs ${want}d`);

      return {
        matched: true,
        occurrenceKey: `no_outbound_since:${from}:${want}`,
        snapshot: {
          last_outbound_at: facts.lastOutboundAt,
          measured_from: from,
          days_since_outbound: elapsed,
          threshold: want,
        },
      };
    }

    /** They replied. The occurrence is that specific message. */
    case "inbound_received": {
      if (!facts.hasNewInbound) return NO_MATCH("no new inbound this evaluation");
      if (!facts.lastInboundAt) return NO_MATCH("inbound flagged but no timestamp");

      return {
        matched: true,
        occurrenceKey: `inbound_received:${facts.lastInboundAt}`,
        snapshot: { last_inbound_at: facts.lastInboundAt },
      };
    }

    /*
     * A lead_state field equals a value — the semantic triggers.
     *
     * The occurrence is the classification, so re-reading the same lead_state
     * does not re-fire. A fresh classification with the same verdict is a new
     * occurrence, which is correct: it is new evidence, re-confirmed.
     */
    case "classification_match": {
      const { field, value } = cfg;
      if (!field || value === undefined) {
        return NO_MATCH("trigger_config.field or .value missing");
      }
      if (!facts.leadState) return NO_MATCH("lead has never been classified");

      const actual = facts.leadState[field];
      if (actual !== value) return NO_MATCH(`${field} is ${String(actual)}, not ${String(value)}`);

      return {
        matched: true,
        occurrenceKey: `classification_match:${field}:${String(value)}:${facts.leadStateAt ?? NEVER}`,
        snapshot: { field, expected: value, actual, classified_at: facts.leadStateAt },
      };
    }

    /*
     * Moved into or out of a stage.
     *
     * Requires previousStage, so this only fires on an evaluation that follows
     * an actual move rather than on every routine sweep.
     */
    case "stage_changed": {
      const target = cfg.stage;
      if (!target) return NO_MATCH("trigger_config.stage missing");
      if (!facts.previousStage) return NO_MATCH("not a stage-change evaluation");
      if (facts.previousStage === facts.stage) return NO_MATCH("stage did not actually change");

      const direction = cfg.direction ?? "into";
      const hit =
        direction === "into" ? facts.stage === target : facts.previousStage === target;

      if (!hit) {
        return NO_MATCH(
          `moved ${facts.previousStage} -> ${facts.stage}, not ${direction} ${target}`
        );
      }

      return {
        matched: true,
        occurrenceKey: `stage_changed:${direction}:${target}:${facts.stageChangedAt ?? NEVER}`,
        snapshot: {
          from: facts.previousStage,
          to: facts.stage,
          direction,
          target,
          stage_changed_at: facts.stageChangedAt,
        },
      };
    }
  }
}
