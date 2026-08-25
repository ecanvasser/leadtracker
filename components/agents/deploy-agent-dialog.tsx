"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Bot, Loader2, Play, Trash2 } from "lucide-react";
import {
  HYPOTHESIS_LABELS,
  type AgentPlan,
  type ContactAgent,
  type Hypothesis,
} from "@/lib/agents/types";

const MIN_CONTEXT_CHARS = 20;

/** Sequence lengths worth offering. Anything longer is a nurture campaign. */
const DURATIONS = [7, 14, 21, 30];

interface Props {
  contactId: string;
  contactName: string;
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
}

/**
 * Deploy an agent for one lead.
 *
 * Two steps on purpose: write the brief, then read the plan. The plan is shown
 * before anything is scheduled because a sequence of messages to a client is
 * not something to find out about afterwards — the same reason workflows have
 * a dry run and drafts have an approval card.
 */
export function DeployAgentDialog({
  contactId,
  contactName,
  open,
  onClose,
  onChanged,
}: Props) {
  const [context, setContext] = useState("");
  const [goal, setGoal] = useState("");
  const [durationDays, setDurationDays] = useState(14);
  const [building, setBuilding] = useState(false);
  const [activating, setActivating] = useState(false);
  const [agent, setAgent] = useState<ContactAgent | null>(null);

  useEffect(() => {
    if (!open) {
      setContext("");
      setGoal("");
      setDurationDays(14);
      setAgent(null);
      setBuilding(false);
      setActivating(false);
    }
  }, [open]);

  if (!open) return null;

  const contextShort = context.trim().length < MIN_CONTEXT_CHARS;

  async function build() {
    setBuilding(true);
    const res = await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contactId, context, goal, durationDays }),
    });
    setBuilding(false);

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error ?? "Could not build a plan");
      return;
    }
    setAgent(body.agent);
  }

  async function activate() {
    if (!agent) return;
    setActivating(true);
    const res = await fetch(`/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "activate" }),
    });
    setActivating(false);

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error ?? "Could not activate");
      return;
    }
    toast.success(`Agent deployed for ${contactName}`);
    onChanged?.();
    onClose();
  }

  async function discard() {
    if (!agent) return;
    await fetch(`/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "retire" }),
    });
    onChanged?.();
    onClose();
  }

  const plan = (agent?.plan ?? null) as AgentPlan | null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-xl border border-border bg-background p-5 shadow-xl">
        <div className="mb-4 flex items-center gap-2">
          <Bot className="h-4 w-4" />
          <h2 className="text-sm font-semibold">
            {plan ? "Review the plan" : `Deploy an agent for ${contactName}`}
          </h2>
        </div>

        {!plan ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ctx">
                What do you know about this lead?
                <span className="ml-1 text-red-500">*</span>
              </Label>
              <textarea
                id="ctx"
                value={context}
                onChange={(e) => setContext(e.target.value)}
                rows={5}
                placeholder="He agreed to the lock fee then went quiet. Mentioned his wife wasn't sure about the timing. Thinks another lender quoted him lower but couldn't say what the terms were."
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm leading-relaxed"
              />
              {/*
                Said plainly rather than as a validation error after the fact.
                This box is the entire reason the feature is allowed to write
                to someone outside the quoted window.
              */}
              <p className="text-xs text-muted-foreground">
                Required. The agent writes from what you tell it here — it is the
                difference between a real follow-up and a generic nudge.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="goal">What do you want to happen?</Label>
              <Input
                id="goal"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="Get him to pay the lock fee, or tell me what's stopping him"
              />
            </div>

            <div className="space-y-2">
              <Label>Over how long?</Label>
              <div className="flex gap-1">
                {DURATIONS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDurationDays(d)}
                    className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                      durationDays === d
                        ? "bg-primary text-primary-foreground font-medium"
                        : "text-muted-foreground hover:bg-accent"
                    }`}
                  >
                    {d} days
                  </button>
                ))}
              </div>
            </div>

            <div className="flex gap-2 pt-1">
              <Button
                onClick={build}
                disabled={building || contextShort || !goal.trim()}
                className="flex-1"
              >
                {building ? (
                  <>
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    Building the plan
                  </>
                ) : (
                  "Build plan"
                )}
              </Button>
              <Button variant="outline" onClick={onClose} disabled={building}>
                Cancel
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Nothing is scheduled yet. You&apos;ll see the plan before it can act,
              and every message still asks you in Telegram before it sends.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm">{plan.summary}</p>

            <ol className="space-y-2.5">
              {plan.steps.map((s) => (
                <li
                  key={s.step}
                  className="rounded-lg border border-border/60 px-3 py-2.5"
                >
                  <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">
                      Day {s.day}
                    </span>
                    <span className="rounded bg-muted px-1.5 py-0.5">
                      {HYPOTHESIS_LABELS[s.hypothesis as Hypothesis] ?? "Unclear"}
                    </span>
                  </div>
                  <p className="text-sm leading-relaxed">{s.angle}</p>
                  {s.rationale && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {s.rationale}
                    </p>
                  )}
                </li>
              ))}
            </ol>

            <div className="flex gap-2">
              <Button onClick={activate} disabled={activating} className="flex-1">
                {activating ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Play className="mr-1.5 h-4 w-4" />
                )}
                Activate
              </Button>
              <Button variant="outline" onClick={discard} disabled={activating}>
                <Trash2 className="mr-1.5 h-4 w-4" />
                Discard
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Each touch becomes a Telegram card you approve. A reply from them
              pauses the whole sequence.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
