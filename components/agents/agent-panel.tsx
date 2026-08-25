"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Bot, Pause, Play, X } from "lucide-react";
import { DeployAgentDialog } from "@/components/agents/deploy-agent-dialog";
import {
  HYPOTHESIS_LABELS,
  isLiveAgent,
  type AgentPlan,
  type AgentTouch,
  type ContactAgent,
  type Hypothesis,
} from "@/lib/agents/types";

const STATUS_LABELS: Record<ContactAgent["status"], string> = {
  draft: "Plan built, not started",
  active: "Running",
  paused: "Paused",
  completed: "Finished",
  retired: "Ended",
};

/**
 * The agent's state on one lead.
 *
 * Shows what it has done and what it will do next, in that order, because the
 * question this panel answers is "what is this thing about to send on my
 * behalf" — not "what did I configure".
 */
export function AgentPanel({
  contactId,
  contactName,
}: {
  contactId: string;
  contactName: string;
}) {
  const [agent, setAgent] = useState<ContactAgent | null>(null);
  const [touches, setTouches] = useState<AgentTouch[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents?contactId=${contactId}`);
      const body = await res.json();
      setAgent(body.agent ?? null);
      setTouches(body.touches ?? []);
    } catch {
      // A panel that cannot load is not worth an error toast on page open.
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => {
    load();
  }, [load]);

  async function act(action: "pause" | "resume" | "retire") {
    if (!agent) return;
    setBusy(true);
    const res = await fetch(`/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setBusy(false);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error ?? "Could not update the agent");
      return;
    }
    await load();
  }

  if (loading) return null;

  const live = agent && isLiveAgent(agent.status);
  const plan = (agent?.plan ?? null) as AgentPlan | null;

  return (
    <div className="rounded-xl border border-border/60 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4" />
          <h3 className="text-sm font-semibold">Follow-up agent</h3>
        </div>

        {!live && (
          <Button size="sm" onClick={() => setDeployOpen(true)}>
            Deploy agent
          </Button>
        )}
      </div>

      {!agent || !live ? (
        <p className="text-xs text-muted-foreground">
          {agent
            ? `Last agent ${STATUS_LABELS[agent.status].toLowerCase()}${
                agent.paused_reason ? ` — ${agent.paused_reason}` : ""
              }.`
            : "Give it what you know about this lead and it plans a sequence of follow-ups. Every message still asks you before it sends."}
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-xs">
            <span
              className={`rounded px-1.5 py-0.5 font-medium ${
                agent.status === "active"
                  ? "bg-emerald-600/15 text-emerald-500"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {STATUS_LABELS[agent.status]}
            </span>
            {/*
              A paused agent without its reason is the Waiting-list problem
              again: a state you cannot act on because you cannot tell why it
              is in it.
            */}
            {agent.paused_reason && agent.status !== "active" && (
              <span className="text-muted-foreground">{agent.paused_reason}</span>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            <span className="text-foreground">Goal:</span> {agent.goal}
          </p>

          {plan && (
            <ol className="space-y-1.5">
              {plan.steps.map((s) => {
                const t = touches.find((x) => x.step_index === s.step);
                const settled = t && t.status !== "pending";
                return (
                  <li
                    key={s.step}
                    className={`flex gap-2 text-xs ${
                      settled ? "text-muted-foreground" : ""
                    }`}
                  >
                    <span className="w-12 shrink-0 tabular-nums">Day {s.day}</span>
                    <span className="w-20 shrink-0">
                      {HYPOTHESIS_LABELS[s.hypothesis as Hypothesis]}
                    </span>
                    <span className="flex-1 leading-relaxed">{s.angle}</span>
                    {t && (
                      <span className="shrink-0 text-muted-foreground">
                        {t.status === "pending" ? "" : t.status}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          )}

          <div className="flex gap-2 pt-1">
            {agent.status === "active" ? (
              <Button size="sm" variant="outline" onClick={() => act("pause")} disabled={busy}>
                <Pause className="mr-1.5 h-3.5 w-3.5" />
                Pause
              </Button>
            ) : agent.status === "paused" ? (
              <Button size="sm" variant="outline" onClick={() => act("resume")} disabled={busy}>
                <Play className="mr-1.5 h-3.5 w-3.5" />
                Resume
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => act("retire")} disabled={busy}>
              <X className="mr-1.5 h-3.5 w-3.5" />
              End
            </Button>
          </div>
        </div>
      )}

      <DeployAgentDialog
        contactId={contactId}
        contactName={contactName}
        open={deployOpen}
        onClose={() => setDeployOpen(false)}
        onChanged={load}
      />
    </div>
  );
}
