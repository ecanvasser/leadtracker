"use client";

/**
 * The workflow list (spec 4.5).
 *
 * A page listing workflows with their enabled/dry-run/off state, a form to
 * add one, and the run history per workflow so Eddie can see what each has
 * been doing. No visual canvas — a list of rules he can actually read.
 */

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Plus, Trash2, ChevronDown, ChevronRight, Loader2, PauseCircle } from "lucide-react";
import { STAGE_LABELS, ADVERSE_REASON_LABELS, type AdverseReason, type AllStages } from "@/types/db";
import { workflowMode, type Workflow, type WorkflowRun, type WorkflowMode } from "@/lib/workflows/types";
import { WorkflowForm, type CampaignOption } from "./workflow-form";

const MODE_BADGE: Record<WorkflowMode, { label: string; className: string }> = {
  live: { label: "Live", className: "bg-green-500/15 text-green-600 dark:text-green-400" },
  dry_run: { label: "Dry run", className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  off: { label: "Off", className: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400" },
};

const STATUS_STYLE: Record<string, string> = {
  dry_run: "text-amber-600 dark:text-amber-400",
  executed: "text-green-600 dark:text-green-400",
  pending_approval: "text-blue-600 dark:text-blue-400",
  skipped: "text-muted-foreground",
  failed: "text-red-500",
};

/** Plain-English one-liner for a rule, so the list reads without decoding. */
function describe(w: Workflow, campaigns: CampaignOption[]): string {
  const cfg = w.trigger_config ?? {};
  const when =
    w.trigger_type === "no_inbound_since"
      ? `they haven't replied in ${cfg.days} day${cfg.days === 1 ? "" : "s"}`
      : w.trigger_type === "no_outbound_since"
        ? `I haven't messaged them in ${cfg.days} day${cfg.days === 1 ? "" : "s"}`
        : w.trigger_type === "days_in_stage"
          ? `they've been in ${STAGE_LABELS[cfg.stage as AllStages] ?? cfg.stage} for ${cfg.days} days`
          : w.trigger_type === "inbound_received"
            ? "they reply"
            : w.trigger_type === "stage_changed"
              ? `they move ${cfg.direction === "out_of" ? "out of" : "into"} ${STAGE_LABELS[cfg.stage as AllStages] ?? cfg.stage}`
              : `the classifier says ${String(cfg.field).replace(/_/g, " ")} is ${String(cfg.value).replace(/_/g, " ")}`;

  const ac = w.action_config ?? {};
  const campaign = campaigns.find((c) => c.id === ac.campaign_id);
  const then =
    w.action_type === "add_to_bonzo_campaign"
      ? `move them to ${campaign?.name ?? `campaign ${ac.campaign_id}`}`
      : w.action_type === "move_stage"
        ? `move them to ${STAGE_LABELS[ac.stage as AllStages] ?? ac.stage}`
        : w.action_type === "mark_adverse"
          ? `mark adverse (${ADVERSE_REASON_LABELS[ac.reason as AdverseReason] ?? ac.reason})`
          : w.action_type === "notify_telegram"
            ? "send me a Telegram note"
            : w.action_type === "create_task"
              ? "create a task"
              : "put a card in the daily queue";

  return `When ${when}, ${then}.`;
}

export function WorkflowsClient() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [killSwitchOn, setKillSwitchOn] = useState(true);
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);
  const [campaignError, setCampaignError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Workflow | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/workflows");
      const data = await res.json();
      if (res.ok) {
        setWorkflows(data.workflows ?? []);
        setRuns(data.runs ?? []);
        setKillSwitchOn(data.workflowsEnabled ?? true);
      }
    } catch {
      toast.error("Could not load workflows");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    // Campaigns come from Bonzo and need the `campaigns` token scope. A
    // failure here is reported inline on the action rather than silently
    // producing an empty dropdown.
    fetch("/api/workflows/campaigns")
      .then(async (r) => {
        const d = await r.json();
        if (r.ok) setCampaigns(d.campaigns ?? []);
        else setCampaignError(d.error ?? "Could not read campaigns");
      })
      .catch(() => setCampaignError("Could not reach Bonzo"));
  }, []);

  async function setMode(w: Workflow, mode: WorkflowMode) {
    const patch =
      mode === "off"
        ? { enabled: false }
        : mode === "dry_run"
          ? { enabled: true, dry_run: true }
          : { enabled: true, dry_run: false };

    const res = await fetch(`/api/workflows/${w.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      toast.success(`${w.name} is now ${MODE_BADGE[mode].label.toLowerCase()}`);
      load();
    } else {
      const d = await res.json();
      toast.error(d.error ?? "Could not change state");
    }
  }

  async function remove(w: Workflow) {
    const res = await fetch(`/api/workflows/${w.id}`, { method: "DELETE" });
    if (res.ok) {
      toast.success(`Deleted ${w.name}`);
      load();
    } else {
      toast.error("Could not delete");
    }
  }

  const runsFor = (id: string) => runs.filter((r) => r.workflow_id === id);

  if (loading) {
    return (
      <div className="p-6 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading workflows…
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto w-full">
      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h1 className="text-lg font-semibold">Workflows</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Rules that decide who gets chased and when. Only the first matching
            rule fires for a lead.
          </p>
        </div>
        {!creating && !editing && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4 mr-1" /> New
          </Button>
        )}
      </div>

      {/*
        The kill switch state belongs at the top of this page. A list of "Live"
        badges is actively misleading if evaluation is globally paused, and
        that is exactly the moment someone concludes the engine is broken.
      */}
      {!killSwitchOn && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
          <PauseCircle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-700 dark:text-amber-300">
            Workflows are globally paused. Nothing below will fire, whatever its
            state says. Resume with <code>/resume</code> in Telegram.
          </p>
        </div>
      )}

      {(creating || editing) && (
        <div className="mb-6 rounded-xl border border-border/60 p-4">
          <h2 className="text-sm font-semibold mb-4">
            {editing ? `Edit ${editing.name}` : "New workflow"}
          </h2>
          <WorkflowForm
            initial={editing}
            campaigns={campaigns}
            campaignError={campaignError}
            onSaved={() => {
              setCreating(false);
              setEditing(null);
              load();
            }}
            onCancel={() => {
              setCreating(false);
              setEditing(null);
            }}
          />
        </div>
      )}

      {workflows.length === 0 && !creating ? (
        <div className="text-center py-16 text-muted-foreground text-sm">
          No workflows yet. Add one and leave it in dry-run for a few days.
        </div>
      ) : (
        <div className="space-y-2">
          {workflows.map((w) => {
            const mode = workflowMode(w);
            const badge = MODE_BADGE[mode];
            const wfRuns = runsFor(w.id);
            const open = expanded === w.id;

            return (
              <div key={w.id} className="rounded-xl border border-border/60 overflow-hidden">
                <div className="flex items-start gap-3 p-3">
                  <button
                    onClick={() => setExpanded(open ? null : w.id)}
                    className="mt-0.5 text-muted-foreground hover:text-foreground"
                    aria-label={open ? "Hide history" : "Show history"}
                  >
                    {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </button>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{w.name}</span>
                      <Badge
                        variant="secondary"
                        className={`text-[10px] px-1.5 py-0 border-0 ${badge.className}`}
                      >
                        {badge.label}
                      </Badge>
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal">
                        priority {w.priority}
                      </Badge>
                      {w.requires_approval && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal">
                          asks first
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {describe(w, campaigns)}
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {wfRuns.length === 0
                        ? "Never fired"
                        : `${wfRuns.length} run${wfRuns.length === 1 ? "" : "s"}`}
                    </p>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <Select value={mode} onValueChange={(v) => setMode(w, v as WorkflowMode)}>
                      <SelectTrigger className="h-8 w-[110px] text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="off">Off</SelectItem>
                        <SelectItem value="dry_run">Dry run</SelectItem>
                        <SelectItem value="live">Live</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(w)} className="h-8 text-xs">
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => remove(w)}
                      className="h-8 w-8 p-0 text-muted-foreground hover:text-red-500"
                      aria-label={`Delete ${w.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                {open && (
                  <div className="border-t border-border/60 bg-muted/20 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                      History
                    </p>
                    {wfRuns.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        Nothing yet. In dry-run this fills up with what it would
                        have done.
                      </p>
                    ) : (
                      <div className="space-y-1.5">
                        {wfRuns.slice(0, 20).map((r) => (
                          <div key={r.id} className="text-xs flex items-start gap-2">
                            <span className="text-muted-foreground tabular-nums shrink-0">
                              {new Date(r.fired_at).toLocaleDateString("en-US", {
                                month: "short",
                                day: "numeric",
                              })}
                            </span>
                            <span className={`shrink-0 ${STATUS_STYLE[r.status] ?? ""}`}>
                              {r.status.replace(/_/g, " ")}
                            </span>
                            {r.error && <span className="text-red-500">{r.error}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
