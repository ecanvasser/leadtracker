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
import {
  DEFAULT_CADENCE_CONFIG,
  type CadenceConfig,
} from "@/lib/cadence/config";

interface CadenceSettingsProps {
  initialConfig: CadenceConfig;
  initialBrokerName: string;
  initialBrokerCompany: string;
  initialTimezone: string;
}

export function CadenceSettings({
  initialConfig,
  initialBrokerName,
  initialBrokerCompany,
  initialTimezone,
}: CadenceSettingsProps) {
  const [config, setConfig] = useState<CadenceConfig>(initialConfig);
  const [brokerName, setBrokerName] = useState(initialBrokerName);
  const [brokerCompany, setBrokerCompany] = useState(initialBrokerCompany);
  const [timezone, setTimezone] = useState(initialTimezone);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  function set<K extends keyof CadenceConfig>(key: K, value: CadenceConfig[K]) {
    setConfig((c) => ({ ...c, [key]: value }));
    setDirty(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch("/api/settings/cadence", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config, brokerName, brokerCompany, timezone }),
      });
      const data = await res.json();
      if (data.error) {
        toast.error(data.error);
      } else {
        setDirty(false);
        toast.success("Settings saved");
      }
    } catch {
      toast.error("Failed to save settings");
    }
    setSaving(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cadence &amp; identity</CardTitle>
        <CardDescription>
          How hard the queue works each lane, and how you introduce yourself.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="tz">Timezone</Label>
          <Input
            id="tz"
            value={timezone}
            onChange={(e) => {
              setTimezone(e.target.value);
              setDirty(true);
            }}
            placeholder="America/Los_Angeles"
          />
          <p className="text-xs text-muted-foreground">
            Must be a Region/City name. Abbreviations like EST are rejected —
            they map to fixed offsets that ignore daylight saving.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="broker-name">Your name</Label>
            <Input
              id="broker-name"
              value={brokerName}
              onChange={(e) => {
                setBrokerName(e.target.value);
                setDirty(true);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="broker-company">Company</Label>
            <Input
              id="broker-company"
              value={brokerCompany}
              onChange={(e) => {
                setBrokerCompany(e.target.value);
                setDirty(true);
              }}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground -mt-3">
          Used in the required opener: &ldquo;Hi {"{first_name}"}, this is{" "}
          {brokerName} from {brokerCompany}&rdquo;.
        </p>

        <div className="space-y-2 pt-2">
          <div className="flex items-center gap-2">
            <Checkbox
              id="sat"
              checked={config.work_saturday}
              onCheckedChange={(c) => set("work_saturday", c === true)}
            />
            <Label htmlFor="sat" className="font-normal">
              Work Saturdays
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="sun"
              checked={config.work_sunday}
              onCheckedChange={(c) => set("work_sunday", c === true)}
            />
            <Label htmlFor="sun" className="font-normal">
              Work Sundays
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="sat-calls"
              checked={config.saturday_calls}
              onCheckedChange={(c) => set("saturday_calls", c === true)}
            />
            <Label htmlFor="sat-calls" className="font-normal">
              Allow calls on Saturday
            </Label>
          </div>
        </div>

        <NumberField
          id="sat-max"
          label="Saturday message cap"
          value={config.saturday_max_messages}
          onChange={(v) => set("saturday_max_messages", v)}
          hint="Most a single lead gets on a Saturday."
        />

        <NumberField
          id="in-market-age"
          label="In-market window (days)"
          value={config.in_market_max_age_days}
          onChange={(v) => set("in_market_max_age_days", v)}
          hint="Unclassified leads older than this are treated as blocked rather than actively shopping."
        />

        <NumberField
          id="blocked-interval"
          label="Blocked lane: minimum days between touches"
          value={config.blocked_min_days_between_touches}
          onChange={(v) => set("blocked_min_days_between_touches", v)}
          hint="A blocked lead does not need a rhythm, it needs a reason. This is the floor."
        />

        <NumberField
          id="unresponsive-max"
          label="Unresponsive: attempts before recommending Adverse"
          value={config.unresponsive_max_consecutive}
          onChange={(v) => set("unresponsive_max_consecutive", v)}
          hint="Consecutive messages with no reply before the lead is surfaced as dead."
        />

        <div className="flex items-center gap-3">
          <Button onClick={handleSave} disabled={saving || !dirty} size="sm">
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save changes
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setConfig({ ...DEFAULT_CADENCE_CONFIG });
              setDirty(true);
            }}
          >
            Reset to defaults
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (v: number) => void;
  hint: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={0}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
