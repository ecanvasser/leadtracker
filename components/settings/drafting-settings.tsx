"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { toast } from "sonner";
import { Loader2, Save } from "lucide-react";

export type DraftingMode = "off" | "dry_run" | "live";

export interface DraftingSettings {
  drafting_mode: DraftingMode;
  draft_schedule_hours: number[];
  max_redrafts_per_day: number;
  min_hours_since_last_message: number;
}

/**
 * The same three-state trust ladder the workflow rules use.
 *
 * Phase 8 section 6 is explicit that this pattern stays exactly as built, and
 * drafting has the strongest claim on it of anything in the app: it is the one
 * feature that writes prose to a client under Eddie's name, and the previous
 * drafting system was retired in Phase 7 precisely because nobody watched it
 * before trusting it.
 *
 * Off is the default and the shipped state. Live still asks in Telegram before
 * anything sends.
 */
const MODES: { value: DraftingMode; label: string; blurb: string }[] = [
  {
    value: "off",
    label: "Off",
    blurb: "No drafts are generated. Nothing costs anything.",
  },
  {
    value: "dry_run",
    label: "Dry run",
    blurb:
      "Drafts are written and sent to Telegram to read, but Approve does nothing. This is how to find out whether they sound like you before they can act.",
  },
  {
    value: "live",
    label: "Live",
    blurb:
      "Drafts go to Telegram and Approve sends them through Bonzo. Nothing sends without your tap.",
  },
];

export function DraftingSettingsPanel({
  initial,
  playbookLoaded,
}: {
  initial: DraftingSettings;
  playbookLoaded: boolean;
}) {
  const [mode, setMode] = useState<DraftingMode>(initial.drafting_mode);
  const [slots, setSlots] = useState(initial.draft_schedule_hours.join(", "));
  const [redrafts, setRedrafts] = useState(String(initial.max_redrafts_per_day));
  const [quiet, setQuiet] = useState(String(initial.min_hours_since_last_message));
  const [saving, setSaving] = useState(false);

  async function save() {
    const parsedSlots = slots
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));

    if (parsedSlots.length === 0) {
      toast.error("The schedule needs at least one slot");
      return;
    }

    setSaving(true);
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        drafting_mode: mode,
        // Sorted here so the stored value always reads in the order the slots
        // actually fire, whatever order they were typed in.
        draft_schedule_hours: [...parsedSlots].sort((a, b) => a - b),
        max_redrafts_per_day: Number(redrafts),
        min_hours_since_last_message: Number(quiet),
      }),
    });
    setSaving(false);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(body.error ?? "Could not save");
      return;
    }
    toast.success(mode === "off" ? "Drafting is off" : `Drafting is ${MODES.find((m) => m.value === mode)?.label.toLowerCase()}`);
  }

  const active = MODES.find((m) => m.value === mode);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Drafting in the quoted window</CardTitle>
        <CardDescription>
          Drafts a follow-up for leads in Quoted – Follow Up, within two days of
          the quote. Nowhere else: not Hot Lead, not Needs Quote, not after a
          handoff.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label>Mode</Label>
          <div className="flex items-center gap-1">
            {MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => setMode(m.value)}
                className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                  mode === m.value
                    ? m.value === "live"
                      ? "bg-emerald-600 text-white font-medium"
                      : "bg-primary text-primary-foreground font-medium"
                    : "text-muted-foreground hover:bg-accent"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          {/* The consequence is stated where the choice is made, rather than
              discovered afterwards — the same reason the campaign picker
              explains what enrolling replaces. */}
          <p className="text-xs text-muted-foreground">{active?.blurb}</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="slots">Draft at (hours)</Label>
            <Input
              id="slots"
              value={slots}
              onChange={(e) => setSlots(e.target.value)}
              placeholder="3, 24"
            />
            <p className="text-xs text-muted-foreground">
              Hours after the last message, not after the quote. Never two in
              one day.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="quiet">Hold off below (hours)</Label>
            <Input
              id="quiet"
              type="number"
              min={0}
              max={168}
              value={quiet}
              onChange={(e) => setQuiet(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              If anyone sent a message more recently than this, nothing is
              drafted. Your own messages count.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="redrafts">Redrafts per lead per day</Label>
            <Input
              id="redrafts"
              type="number"
              min={0}
              max={20}
              value={redrafts}
              onChange={(e) => setRedrafts(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Caps the Redraft button, which is the one loop here that could run
              away.
            </p>
          </div>
        </div>

        {/*
          Whether the playbook is actually loaded.
          
          It lives in the repo, so there is no control for it here — but with
          no indicator, the only way to know a paste had taken effect would be
          to read a draft and guess.
        */}
        <div className="rounded-lg border border-border/60 px-3 py-2.5">
          <p className="text-xs">
            <span className="font-medium">Your playbook:</span>{" "}
            {playbookLoaded ? (
              <span className="text-emerald-500">
                loaded — every draft is written with it
              </span>
            ) : (
              <span className="text-muted-foreground">
                empty. Drafts know only what one lead&apos;s conversation shows.
              </span>
            )}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Your programs, objections and how you answer them. Lives in{" "}
            <code className="rounded bg-muted px-1">lib/ai/playbook.ts</code> so
            it is version-controlled — a change to it shows up in the diff next
            to a change in draft quality.
          </p>
        </div>

        <Button onClick={save} disabled={saving}>
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          Save
        </Button>
      </CardContent>
    </Card>
  );
}
