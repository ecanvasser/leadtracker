"use client";

/**
 * The rule form: trigger → trigger config → optional conditions → action →
 * approval. No visual canvas; 4.5 asks for a list of rules that works rather
 * than a builder that looks impressive.
 *
 * The form deliberately mirrors lib/workflows/validate.ts rather than trying
 * to be cleverer than it. Anything this lets through, the server rejects with
 * the same message, so the two cannot drift into disagreeing about what a
 * valid workflow is.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { ALL_STAGES, STAGE_LABELS, ADVERSE_REASONS, ADVERSE_REASON_LABELS } from "@/types/db";
import { PITCH_RESPONSES, RECOMMENDED_ACTIONS } from "@/lib/insights/lead-state";
import type { TriggerType, ActionType, Workflow } from "@/lib/workflows/types";

export interface CampaignOption {
  id: number;
  name: string;
  prospectsCount: string | null;
  sequenceEnabled: boolean;
}

const TRIGGER_LABELS: Record<TriggerType, string> = {
  no_inbound_since: "They haven't replied in N days",
  no_outbound_since: "I haven't messaged them in N days",
  days_in_stage: "N days in a stage",
  inbound_received: "They replied",
  classification_match: "The classifier read something specific",
  stage_changed: "Moved into or out of a stage",
};

const ACTION_LABELS: Record<ActionType, string> = {
  add_to_bonzo_campaign: "Move to a Bonzo campaign",
  move_stage: "Move to a stage",
  notify_telegram: "Send me a Telegram note",
  create_task: "Create a task",
  queue_follow_up: "Put a card in the daily queue",
  mark_adverse: "Mark adverse",
};

const DAY_TRIGGERS: TriggerType[] = ["days_in_stage", "no_inbound_since", "no_outbound_since"];

const CLASSIFICATION_FIELDS = [
  { value: "pitch_response", label: "What they did with the number" },
  { value: "recommended_action", label: "What the classifier recommends" },
  { value: "evidence_confidence", label: "How confident the evidence is" },
] as const;

export interface WorkflowFormProps {
  initial?: Workflow | null;
  campaigns: CampaignOption[];
  campaignError: string | null;
  onSaved: () => void;
  onCancel: () => void;
}

export function WorkflowForm({
  initial,
  campaigns,
  campaignError,
  onSaved,
  onCancel,
}: WorkflowFormProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [triggerType, setTriggerType] = useState<TriggerType>(
    initial?.trigger_type ?? "no_inbound_since"
  );
  const [days, setDays] = useState<string>(String(initial?.trigger_config?.days ?? 2));
  const [triggerStage, setTriggerStage] = useState<string>(
    initial?.trigger_config?.stage ?? "quoted_follow_up"
  );
  const [direction, setDirection] = useState<"into" | "out_of">(
    initial?.trigger_config?.direction ?? "into"
  );
  const [field, setField] = useState<string>(initial?.trigger_config?.field ?? "pitch_response");
  const [value, setValue] = useState<string>(
    (initial?.trigger_config?.value as string) ?? "no_response"
  );

  const [actionType, setActionType] = useState<ActionType>(
    initial?.action_type ?? "notify_telegram"
  );
  const [campaignId, setCampaignId] = useState<string>(
    initial?.action_config?.campaign_id ? String(initial.action_config.campaign_id) : ""
  );
  const [actionStage, setActionStage] = useState<string>(
    (initial?.action_config?.stage as string) ?? "app_in"
  );
  const [adverseReason, setAdverseReason] = useState<string>(
    (initial?.action_config?.reason as string) ?? "not_interested"
  );
  const [text, setText] = useState<string>(
    (initial?.action_config?.message as string) ??
      (initial?.action_config?.title as string) ??
      ""
  );

  const [conditionStage, setConditionStage] = useState<string>(
    initial?.conditions?.stage?.[0] ?? "quoted_follow_up"
  );
  const [useStageCondition, setUseStageCondition] = useState(
    Boolean(initial?.conditions?.stage?.length)
  );

  const [requiresApproval, setRequiresApproval] = useState(initial?.requires_approval ?? true);
  const [priority, setPriority] = useState<string>(String(initial?.priority ?? 100));

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedCampaign = campaigns.find((c) => String(c.id) === campaignId);

  function buildBody() {
    const triggerConfig: Record<string, unknown> = {};
    if (DAY_TRIGGERS.includes(triggerType)) triggerConfig.days = Number(days);
    if (triggerType === "days_in_stage") triggerConfig.stage = triggerStage;
    if (triggerType === "stage_changed") {
      triggerConfig.stage = triggerStage;
      triggerConfig.direction = direction;
    }
    if (triggerType === "classification_match") {
      triggerConfig.field = field;
      triggerConfig.value = value;
    }

    const actionConfig: Record<string, unknown> = {};
    if (actionType === "add_to_bonzo_campaign") actionConfig.campaign_id = Number(campaignId);
    if (actionType === "move_stage") actionConfig.stage = actionStage;
    if (actionType === "mark_adverse") actionConfig.reason = adverseReason;
    if (actionType === "notify_telegram") actionConfig.message = text;
    if (actionType === "create_task") actionConfig.title = text;

    return {
      name,
      trigger_type: triggerType,
      trigger_config: triggerConfig,
      conditions: useStageCondition ? { stage: [conditionStage] } : {},
      action_type: actionType,
      action_config: actionConfig,
      requires_approval: requiresApproval,
      priority: Number(priority),
    };
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        initial ? `/api/workflows/${initial.id}` : "/api/workflows",
        {
          method: initial ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildBody()),
        }
      );
      const data = await res.json();
      if (!res.ok) setError(data.error ?? "Could not save");
      else onSaved();
    } catch {
      setError("Could not save");
    }
    setSaving(false);
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="wf-name">Name</Label>
        <Input
          id="wf-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="2-day handoff to auto follow-up"
        />
      </div>

      {/* --- Trigger ------------------------------------------------------ */}
      <div className="space-y-3 rounded-lg border border-border/60 p-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          When
        </p>

        <Select value={triggerType} onValueChange={(v) => setTriggerType(v as TriggerType)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {(Object.keys(TRIGGER_LABELS) as TriggerType[]).map((t) => (
              <SelectItem key={t} value={t}>{TRIGGER_LABELS[t]}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {DAY_TRIGGERS.includes(triggerType) && (
          <div className="space-y-1.5">
            <Label htmlFor="wf-days">Days</Label>
            <Input
              id="wf-days"
              type="number"
              min={1}
              max={365}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="w-28"
            />
          </div>
        )}

        {(triggerType === "days_in_stage" || triggerType === "stage_changed") && (
          <div className="space-y-1.5">
            <Label>Stage</Label>
            <Select value={triggerStage} onValueChange={setTriggerStage}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {ALL_STAGES.map((s) => (
                  <SelectItem key={s} value={s}>{STAGE_LABELS[s]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {triggerType === "stage_changed" && (
          <div className="space-y-1.5">
            <Label>Direction</Label>
            <Select value={direction} onValueChange={(v) => setDirection(v as "into" | "out_of")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="into">Moved into it</SelectItem>
                <SelectItem value="out_of">Moved out of it</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        {triggerType === "classification_match" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Field</Label>
              <Select
                value={field}
                onValueChange={(v) => {
                  setField(v);
                  setValue(
                    v === "pitch_response"
                      ? "no_response"
                      : v === "recommended_action"
                        ? "hand_off"
                        : "high"
                  );
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CLASSIFICATION_FIELDS.map((f) => (
                    <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Is</Label>
              <Select value={value} onValueChange={setValue}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(field === "pitch_response"
                    ? PITCH_RESPONSES
                    : field === "recommended_action"
                      ? RECOMMENDED_ACTIONS
                      : (["high", "medium", "low"] as const)
                  ).map((v) => (
                    <SelectItem key={v} value={v}>{v.replace(/_/g, " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </div>

      {/* --- Conditions --------------------------------------------------- */}
      <div className="space-y-3 rounded-lg border border-border/60 p-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Only if (optional)
        </p>
        <div className="flex items-center gap-2">
          <Checkbox
            id="wf-cond-stage"
            checked={useStageCondition}
            onCheckedChange={(c) => setUseStageCondition(c === true)}
          />
          <Label htmlFor="wf-cond-stage" className="font-normal">The lead is in a specific stage</Label>
        </div>
        {useStageCondition && (
          <Select value={conditionStage} onValueChange={setConditionStage}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {ALL_STAGES.map((s) => (
                <SelectItem key={s} value={s}>{STAGE_LABELS[s]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* --- Action ------------------------------------------------------- */}
      <div className="space-y-3 rounded-lg border border-border/60 p-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Then
        </p>

        <Select value={actionType} onValueChange={(v) => setActionType(v as ActionType)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {(Object.keys(ACTION_LABELS) as ActionType[]).map((a) => (
              <SelectItem key={a} value={a}>{ACTION_LABELS[a]}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {actionType === "add_to_bonzo_campaign" && (
          <div className="space-y-1.5">
            <Label>Campaign</Label>
            {campaignError ? (
              <p className="text-xs text-red-500">{campaignError}</p>
            ) : (
              <>
                <Select value={campaignId} onValueChange={setCampaignId}>
                  <SelectTrigger><SelectValue placeholder="Pick a campaign" /></SelectTrigger>
                  <SelectContent>
                    {campaigns.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.name}
                        {c.prospectsCount ? ` (${c.prospectsCount})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/*
                  Enrolling REPLACES the lead's current campaign, and a live
                  sequence starts messaging on enrolment. Both facts change
                  what this action means, so they are stated at the point of
                  choosing rather than left to be discovered.
                */}
                {selectedCampaign && (
                  <p className="text-[11px] text-muted-foreground">
                    {selectedCampaign.sequenceEnabled
                      ? "This campaign has a live sequence — enrolling starts its messages."
                      : "This campaign's sequence is off — enrolling sends nothing."}{" "}
                    Moving a lead here replaces whatever campaign they are in now.
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {actionType === "move_stage" && (
          <Select value={actionStage} onValueChange={setActionStage}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {ALL_STAGES.map((s) => (
                <SelectItem key={s} value={s}>{STAGE_LABELS[s]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {actionType === "mark_adverse" && (
          <Select value={adverseReason} onValueChange={setAdverseReason}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {ADVERSE_REASONS.map((r) => (
                <SelectItem key={r} value={r}>{ADVERSE_REASON_LABELS[r]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {(actionType === "notify_telegram" || actionType === "create_task") && (
          <div className="space-y-1.5">
            <Label htmlFor="wf-text">
              {actionType === "notify_telegram" ? "Message" : "Task title"}
            </Label>
            <Input
              id="wf-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                actionType === "notify_telegram"
                  ? "Gone quiet 2 days after the quote"
                  : "Call about the quote"
              }
            />
          </div>
        )}
      </div>

      {/* --- Safety ------------------------------------------------------- */}
      <div className="space-y-3 rounded-lg border border-border/60 p-3">
        <div className="flex items-center gap-2">
          <Checkbox
            id="wf-approval"
            checked={requiresApproval}
            onCheckedChange={(c) => setRequiresApproval(c === true)}
          />
          <Label htmlFor="wf-approval" className="font-normal">
            Ask me first (Telegram card with Send / Skip)
          </Label>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="wf-priority">Priority</Label>
          <Input
            id="wf-priority"
            type="number"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className="w-28"
          />
          <p className="text-[11px] text-muted-foreground">
            Lower runs first. Only the first matching workflow fires for a lead,
            so a quiet lead cannot land in three campaigns at once.
          </p>
        </div>

        {!initial && (
          <p className="text-[11px] text-muted-foreground">
            New workflows are created switched off and in dry-run. Turn them on
            from the list once you have watched what they would have done.
          </p>
        )}
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex gap-2">
        <Button onClick={save} disabled={saving || !name.trim()} size="sm">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {initial ? "Save changes" : "Create workflow"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
