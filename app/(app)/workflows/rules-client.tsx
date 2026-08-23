"use client";

/**
 * The rules page (Phase 8 section 6).
 *
 * The engine stays; the generic form goes. `lib/workflows/` — evaluation,
 * priority ordering, dry-run, run history, first-match-wins — is untouched.
 * What is replaced is a 460-line form offering six triggers × six actions =
 * 36 combinations, built to express two rules that were already known.
 *
 * The builder is not deleted, only unlinked: it still lives at
 * /workflows/advanced. This is a bet about what Eddie needs, not a claim the
 * code is bad, and if a third rule turns out to be wanted, restoring it is
 * changing one route back.
 *
 * The three-state trust ladder is kept exactly as built. Off / Dry run / Live,
 * with Live still asking via Telegram by default, is the pattern that makes
 * any of this safe to switch on at all.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  PauseCircle,
  ShieldCheck,
} from "lucide-react";
import {
  needsApproval,
  workflowMode,
  type Workflow,
  type WorkflowMode,
  type WorkflowRun,
} from "@/lib/workflows/types";

const MODES: { mode: WorkflowMode; label: string; hint: string }[] = [
  { mode: "off", label: "Off", hint: "Does nothing at all." },
  { mode: "dry_run", label: "Dry run", hint: "Records what it would have done, touching nothing." },
  { mode: "live", label: "Live", hint: "Acts for real." },
];

const STATUS_STYLE: Record<string, string> = {
  dry_run: "text-amber-600 dark:text-amber-400",
  executed: "text-green-600 dark:text-green-400",
  pending_approval: "text-blue-600 dark:text-blue-400",
  skipped: "text-muted-foreground",
  failed: "text-red-500",
};

type RuleKind = "park" | "handoff" | "other";

function kindOf(w: Workflow): RuleKind {
  if (w.action_type !== "add_to_bonzo_campaign") return "other";
  if (w.trigger_type === "stage_changed") return "park";
  if (w.trigger_type === "no_inbound_since") return "handoff";
  return "other";
}

function campaignName(w: Workflow): string {
  const cfg = w.action_config ?? {};
  return (
    (cfg.campaign_name as string | undefined) ??
    `campaign ${String(cfg.campaign_id ?? "?")}`
  );
}

export function RulesClient() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [killSwitchOn, setKillSwitchOn] = useState(true);
  const [loading, setLoading] = useState(true);
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
      toast.error("Could not load rules");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function patch(w: Workflow, body: Record<string, unknown>, success: string) {
    const res = await fetch(`/api/workflows/${w.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      toast.success(success);
      load();
    } else {
      const d = await res.json().catch(() => ({}));
      toast.error(d.error ?? "That didn't go through");
    }
  }

  function setMode(w: Workflow, mode: WorkflowMode) {
    const body =
      mode === "off"
        ? { enabled: false }
        : mode === "dry_run"
          ? { enabled: true, dry_run: true }
          : { enabled: true, dry_run: false };
    patch(w, body, `${w.name} is now ${mode === "dry_run" ? "in dry run" : mode}`);
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading rules…
      </div>
    );
  }

  const park = workflows.filter((w) => kindOf(w) === "park");
  const handoff = workflows.filter((w) => kindOf(w) === "handoff");
  const other = workflows.filter((w) => kindOf(w) === "other");

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto w-full">
      <header className="mb-6">
        <h1 className="text-lg font-semibold">Rules</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Two rules run after a lead is quoted. Only the first one that matches
          a lead fires.
        </p>
      </header>

      {/*
        Kept from Phase 7, and still the most important thing on the page: a
        column of "Live" badges is actively misleading if evaluation is
        globally paused, and that is exactly the moment someone concludes the
        engine is broken.
      */}
      {!killSwitchOn && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
          <PauseCircle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-700 dark:text-amber-300">
            Rules are globally paused. Nothing below will fire, whatever its
            state says. Resume with <code>/resume</code> in Telegram.
          </p>
        </div>
      )}

      {workflows.length === 0 && (
        <p className="rounded-lg border border-border/60 p-4 text-sm text-muted-foreground">
          No rules exist yet. The two pre-built ones are created by migration —
          if this is empty, they have been deleted.
        </p>
      )}

      <div className="space-y-4">
        {park.map((w) => (
          <RuleCard
            key={w.id}
            workflow={w}
            runs={runs.filter((r) => r.workflow_id === w.id)}
            expanded={expanded === w.id}
            onToggleExpand={() => setExpanded(expanded === w.id ? null : w.id)}
            onSetMode={setMode}
            onPatch={patch}
            title="Park them while I work them"
            sentence={
              <>
                When a lead enters <b>Quoted – Follow Up</b>, move them to{" "}
                <b>{campaignName(w)}</b>.
              </>
            }
            why="That campaign sends nothing. It stops Bonzo dripping a lead the same afternoon you're working them — two uncoordinated touches is the thing that reads as automated."
          />
        ))}

        {handoff.map((w) => (
          <RuleCard
            key={w.id}
            workflow={w}
            runs={runs.filter((r) => r.workflow_id === w.id)}
            expanded={expanded === w.id}
            onToggleExpand={() => setExpanded(expanded === w.id ? null : w.id)}
            onSetMode={setMode}
            onPatch={patch}
            title="Hand off after silence"
            editableDays
            sentence={
              <>
                When they haven&rsquo;t replied in{" "}
                <b>{w.trigger_config?.days ?? "?"}</b> days, move them to{" "}
                <b>{campaignName(w)}</b>.
              </>
            }
            why="Only fires when the classifier still reads no reply at all. A price objection or a soft no is a live conversation, and it stays yours."
          />
        ))}

        {other.length > 0 && (
          <section className="pt-2">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Other rules
            </h2>
            {/*
              Anything built in the old form still evaluates, so it still gets
              shown. A rule that fires without appearing on the page that
              claims to list the rules is the worst failure this page can have.
            */}
            <div className="space-y-4">
              {other.map((w) => (
                <RuleCard
                  key={w.id}
                  workflow={w}
                  runs={runs.filter((r) => r.workflow_id === w.id)}
                  expanded={expanded === w.id}
                  onToggleExpand={() => setExpanded(expanded === w.id ? null : w.id)}
                  onSetMode={setMode}
                  onPatch={patch}
                  title={w.name}
                  sentence={
                    <>
                      A custom rule: {w.trigger_type.replace(/_/g, " ")} →{" "}
                      {w.action_type.replace(/_/g, " ")}.
                    </>
                  }
                  why="Built in the advanced builder. Edit it there."
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function RuleCard({
  workflow: w,
  runs,
  expanded,
  onToggleExpand,
  onSetMode,
  onPatch,
  title,
  sentence,
  why,
  editableDays,
}: {
  workflow: Workflow;
  runs: WorkflowRun[];
  expanded: boolean;
  onToggleExpand: () => void;
  onSetMode: (w: Workflow, mode: WorkflowMode) => void;
  onPatch: (w: Workflow, body: Record<string, unknown>, success: string) => void;
  title: string;
  sentence: React.ReactNode;
  why: string;
  editableDays?: boolean;
}) {
  const mode = workflowMode(w);
  const [days, setDays] = useState(String(w.trigger_config?.days ?? ""));

  const dirty = editableDays && days !== String(w.trigger_config?.days ?? "");

  function saveDays() {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 60) {
      toast.error("Days must be a whole number between 1 and 60");
      return;
    }
    onPatch(
      w,
      { trigger_config: { ...w.trigger_config, days: n } },
      `Now fires after ${n} ${n === 1 ? "day" : "days"}`
    );
  }

  return (
    <div className="rounded-xl border border-border/60 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="mt-1 text-sm">{sentence}</p>
          <p className="mt-1.5 text-xs text-muted-foreground">{why}</p>
        </div>
      </div>

      {editableDays && (
        <div className="mt-3 flex items-center gap-2">
          <label className="text-xs text-muted-foreground" htmlFor={`days-${w.id}`}>
            Days of silence
          </label>
          <Input
            id={`days-${w.id}`}
            value={days}
            inputMode="numeric"
            onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))}
            className="h-7 w-16 text-xs"
          />
          {dirty && (
            <Button size="sm" className="h-7 text-xs" onClick={saveDays}>
              Save
            </Button>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        {MODES.map(({ mode: m, label, hint }) => (
          <button
            key={m}
            type="button"
            title={hint}
            onClick={() => onSetMode(w, m)}
            className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
              mode === m
                ? m === "live"
                  ? "bg-green-500/15 text-green-600 dark:text-green-400 font-medium"
                  : m === "dry_run"
                    ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 font-medium"
                    : "bg-accent text-foreground font-medium"
                : "text-muted-foreground hover:bg-accent/60"
            }`}
          >
            {label}
          </button>
        ))}

        {/*
          Phrased as configuration, not as current behaviour, unless the rule
          is actually live. "Acts without asking" beside a rule sitting in Dry
          run is a straight contradiction — it does not act at all — and a
          control panel that contradicts itself is one nobody reads carefully
          after the first time.
        */}
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <ShieldCheck className="size-3.5" />
          {mode === "live"
            ? needsApproval(w)
              ? "Asks in Telegram before acting"
              : "Acts without asking"
            : needsApproval(w)
              ? "When live: asks in Telegram first"
              : "When live: acts without asking"}
        </span>
      </div>

      {mode === "live" && !needsApproval(w) && (
        <p className="mt-2 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          This rule is live and does not ask first. It will move leads into{" "}
          {campaignName(w)} on its own.
        </p>
      )}

      <button
        type="button"
        onClick={onToggleExpand}
        className="mt-3 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="size-3.5" />
        ) : (
          <ChevronRight className="size-3.5" />
        )}
        History ({runs.length})
      </button>

      {expanded && (
        <div className="mt-2 space-y-1 border-t border-border/50 pt-2">
          {runs.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nothing yet. In dry run, this fills up with what the rule would
              have done.
            </p>
          ) : (
            runs.slice(0, 20).map((r) => (
              <div key={r.id} className="flex items-baseline gap-2 text-xs">
                <span className={STATUS_STYLE[r.status] ?? ""}>{r.status.replace(/_/g, " ")}</span>
                <span className="text-muted-foreground">
                  {new Date(r.fired_at).toLocaleString()}
                </span>
                {r.error && <span className="text-red-500">{r.error}</span>}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
