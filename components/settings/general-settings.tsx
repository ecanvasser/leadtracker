"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { toast } from "sonner";
import { Loader2, Save } from "lucide-react";
import type { CadenceConfig } from "@/lib/cadence/config";

export interface UserSettings {
  timezone: string;
  broker_display_name: string;
  broker_company: string;
  morning_digest_time: string;
  quiet_hours_start: string;
  quiet_hours_end: string;
  working_hours_start: string;
  working_hours_end: string;
  daily_token_budget: number;
  cadence_config: CadenceConfig;
}

interface Props {
  initial: UserSettings;
  /** Model routing is env-configured, so it is shown read-only. */
  models: { analysis: string; extract: string };
  todaySpend: { inputTokens: number; outputTokens: number; calls: number };
}

/** A short list of zones rather than all ~600 — these are the plausible ones. */
const TIMEZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Phoenix",
  "America/Chicago",
  "America/New_York",
  "America/Anchorage",
  "Pacific/Honolulu",
];

export function GeneralSettings({ initial, models, todaySpend }: Props) {
  const [settings, setSettings] = useState<UserSettings>(initial);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  function set<K extends keyof UserSettings>(key: K, value: UserSettings[K]) {
    setSettings((s) => ({ ...s, [key]: value }));
    setDirty(true);
  }

  function setCadence<K extends keyof CadenceConfig>(
    key: K,
    value: CadenceConfig[K]
  ) {
    setSettings((s) => ({
      ...s,
      cadence_config: { ...s.cadence_config, [key]: value },
    }));
    setDirty(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const data = await res.json();
      if (data.error) {
        toast.error(data.error);
      } else {
        setSettings((s) => ({ ...s, ...data.settings }));
        setDirty(false);
        toast.success("Settings saved");
      }
    } catch {
      toast.error("Could not save settings");
    }
    setSaving(false);
  }

  const budgetUsedPct = Math.min(
    100,
    Math.round(
      ((todaySpend.inputTokens + todaySpend.outputTokens) /
        Math.max(1, settings.daily_token_budget)) *
        100
    )
  );

  return (
    <div className="space-y-6">
      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>You</CardTitle>
          <CardDescription>
            How you are introduced in a first message. The opener rule checks
            these exactly, so a change here changes what gets rejected.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="broker-name">Your name</Label>
            <Input
              id="broker-name"
              value={settings.broker_display_name}
              onChange={(e) => set("broker_display_name", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="broker-company">Company</Label>
            <Input
              id="broker-company"
              value={settings.broker_company}
              onChange={(e) => set("broker_company", e.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            First messages must open: “Hi {"{first_name}"}, this is{" "}
            {settings.broker_display_name} from {settings.broker_company}”
          </p>
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Time</CardTitle>
          <CardDescription>
            Your timezone decides what “today” means everywhere in the app —
            the queue date, lead age, and every schedule.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="tz">Timezone</Label>
            <select
              id="tz"
              className="w-full h-9 rounded-md border bg-transparent px-3 text-sm"
              value={settings.timezone}
              onChange={(e) => set("timezone", e.target.value)}
            >
              {[...new Set([settings.timezone, ...TIMEZONES])].map((tz) => (
                <option key={tz} value={tz}>
                  {tz.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <TimeField
              id="digest"
              label="Morning digest"
              value={settings.morning_digest_time}
              onChange={(v) => set("morning_digest_time", v)}
            />
            <div />
            <TimeField
              id="work-start"
              label="Working hours from"
              value={settings.working_hours_start}
              onChange={(v) => set("working_hours_start", v)}
            />
            <TimeField
              id="work-end"
              label="until"
              value={settings.working_hours_end}
              onChange={(v) => set("working_hours_end", v)}
            />
            <TimeField
              id="quiet-start"
              label="Quiet hours from"
              value={settings.quiet_hours_start}
              onChange={(v) => set("quiet_hours_start", v)}
            />
            <TimeField
              id="quiet-end"
              label="until"
              value={settings.quiet_hours_end}
              onChange={(v) => set("quiet_hours_end", v)}
            />
          </div>

          <p className="text-xs text-muted-foreground">
            Working hours gate polling and drafting. Quiet hours gate
            notifications to you. They are separate on purpose — you may want a
            digest before the hour you want messages going out to prospects.
          </p>
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Cadence</CardTitle>
          <CardDescription>
            How often leads get contacted, by lane.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <Checkbox
              id="sunday"
              checked={settings.cadence_config.work_sunday}
              onCheckedChange={(c) => setCadence("work_sunday", c === true)}
            />
            <Label htmlFor="sunday" className="font-normal">
              Work Sundays
            </Label>
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="saturday"
              checked={settings.cadence_config.work_saturday}
              onCheckedChange={(c) => setCadence("work_saturday", c === true)}
            />
            <Label htmlFor="saturday" className="font-normal">
              Work Saturdays
            </Label>
          </div>

          {/*
            Phase 7 retirement: the "Include calls on Saturdays" checkbox, the
            in-market window and the Adverse-after-N-unanswered field are gone
            from this page because the lanes that read them are gone. The keys
            stay in cadence_config and in stored jsonb — nothing was migrated —
            they simply no longer have anything to drive, and a control that
            silently does nothing is worse than no control.

            saturday_max_messages was never rendered here (only in the
            orphaned cadence-settings.tsx), so it needed no change.

            The two toggles above still work: they gate whether the engine runs
            at all on a weekend day.
          */}
          <NumberField
            id="blocked-gap"
            label="Minimum gap between touches on a blocked lead"
            suffix="days"
            value={settings.cadence_config.blocked_min_days_between_touches}
            onChange={(v) => setCadence("blocked_min_days_between_touches", v)}
          />
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Models and spend</CardTitle>
          <CardDescription>
            Model routing is set by environment variable so it can be changed
            without a deploy of this page.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="text-xs space-y-1.5">
            {[
              ["Classification", models.analysis, "ANTHROPIC_MODEL_ANALYSIS"],
              ["Call-time extraction", models.extract, "ANTHROPIC_MODEL_EXTRACT"],
            ].map(([label, model, env]) => (
              <div key={env} className="flex items-baseline gap-2">
                <dt className="text-muted-foreground w-52 shrink-0">{label}</dt>
                <dd className="font-mono">{model}</dd>
                <dd className="text-muted-foreground ml-auto font-mono text-[10px]">
                  {env}
                </dd>
              </div>
            ))}
          </dl>

          <div className="space-y-1.5 pt-2">
            <Label htmlFor="budget">Daily token budget</Label>
            <Input
              id="budget"
              type="number"
              min={10000}
              step={100000}
              value={settings.daily_token_budget}
              onChange={(e) => set("daily_token_budget", Number(e.target.value))}
            />
            <p className="text-xs text-muted-foreground">
              Past this, the worker stops making model calls, finishes the queue
              with drafts it already has, and messages you. A runaway loop costs
              one notification rather than a surprise invoice.
            </p>
          </div>

          <div className="pt-1">
            <div className="flex items-baseline justify-between text-xs mb-1">
              <span className="text-muted-foreground">Today</span>
              <span className="tabular-nums">
                {(todaySpend.inputTokens + todaySpend.outputTokens).toLocaleString()} tokens
                {" · "}
                {todaySpend.calls} call{todaySpend.calls === 1 ? "" : "s"}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full transition-all ${
                  budgetUsedPct > 90 ? "bg-red-500" : "bg-primary"
                }`}
                style={{ width: `${budgetUsedPct}%` }}
              />
            </div>
            <p className="text-[10px] text-muted-foreground mt-1 tabular-nums">
              {budgetUsedPct}% of today&apos;s budget
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="sticky bottom-4 flex justify-end">
        <Button onClick={handleSave} disabled={saving || !dirty}>
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          Save changes
        </Button>
      </div>
    </div>
  );
}

function TimeField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        type="time"
        value={value?.slice(0, 5) ?? ""}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function NumberField({
  id,
  label,
  suffix,
  value,
  onChange,
}: {
  id: string;
  label: string;
  suffix: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Label htmlFor={id} className="font-normal text-sm flex-1 min-w-[220px]">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        min={0}
        className="w-20"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="text-xs text-muted-foreground">{suffix}</span>
    </div>
  );
}
