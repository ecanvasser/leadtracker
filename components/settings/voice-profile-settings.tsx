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
import { Loader2, RefreshCw, Save } from "lucide-react";
import type { VoiceProfile } from "@/lib/ai/voice-profile-types";

interface VoiceProfileSettingsProps {
  initialProfile: VoiceProfile | null;
  initialGeneratedAt: string | null;
}

const EMPTY: VoiceProfile = {
  greeting_patterns: [],
  sign_off: "",
  typical_sms_length_chars: 160,
  uses_emoji: false,
  uses_contractions: true,
  capitalization: "sentence",
  exclamation_frequency: "rare",
  common_phrases: [],
  never_uses: [],
};

export function VoiceProfileSettings({
  initialProfile,
  initialGeneratedAt,
}: VoiceProfileSettingsProps) {
  const [profile, setProfile] = useState<VoiceProfile>(initialProfile ?? EMPTY);
  const [generatedAt, setGeneratedAt] = useState<string | null>(initialGeneratedAt);
  const [hasProfile, setHasProfile] = useState(Boolean(initialProfile));
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  function update<K extends keyof VoiceProfile>(key: K, value: VoiceProfile[K]) {
    setProfile((p) => ({ ...p, [key]: value }));
    setDirty(true);
  }

  async function handleRegenerate() {
    setGenerating(true);
    try {
      const res = await fetch("/api/settings/voice-profile", { method: "POST" });
      const data = await res.json();
      if (data.error) {
        toast.error(data.error);
      } else {
        setProfile(data.profile);
        setHasProfile(true);
        setGeneratedAt(new Date().toISOString());
        setDirty(false);
        toast.success(`Voice profile built from ${data.sampleSize} of your messages`);
      }
    } catch {
      toast.error("Failed to build voice profile");
    }
    setGenerating(false);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch("/api/settings/voice-profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile }),
      });
      const data = await res.json();
      if (data.error) {
        toast.error(data.error);
      } else {
        setHasProfile(true);
        setDirty(false);
        toast.success("Voice profile saved");
      }
    } catch {
      toast.error("Failed to save voice profile");
    }
    setSaving(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Voice profile</CardTitle>
        <CardDescription>
          Extracted from your real sent messages and used in every draft. Edit
          anything that looks wrong — a wrong detail here shapes every message.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRegenerate}
            disabled={generating}
          >
            {generating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {hasProfile ? "Rebuild from my messages" : "Build from my messages"}
          </Button>
          {generatedAt && (
            <span className="text-xs text-muted-foreground">
              Updated {new Date(generatedAt).toLocaleDateString()}
            </span>
          )}
        </div>

        {!hasProfile && !generating && (
          <p className="text-sm text-muted-foreground">
            No profile yet. Drafts fall back to short, plain sentences with no
            emoji until you build one.
          </p>
        )}

        <ListField
          label="Greetings you use"
          hint="One per line, exactly as you type them."
          values={profile.greeting_patterns}
          onChange={(v) => update("greeting_patterns", v)}
        />

        <div className="space-y-1.5">
          <Label htmlFor="sign-off">Sign-off</Label>
          <Input
            id="sign-off"
            value={profile.sign_off}
            placeholder="Leave blank if you don't sign off"
            onChange={(e) => update("sign_off", e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="sms-length">Typical SMS length (characters)</Label>
          <Input
            id="sms-length"
            type="number"
            min={20}
            max={320}
            value={profile.typical_sms_length_chars}
            onChange={(e) =>
              update("typical_sms_length_chars", Number(e.target.value))
            }
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="caps">Capitalization</Label>
          <select
            id="caps"
            className="w-full h-9 rounded-md border bg-transparent px-3 text-sm"
            value={profile.capitalization}
            onChange={(e) =>
              update("capitalization", e.target.value as VoiceProfile["capitalization"])
            }
          >
            <option value="sentence">Sentence case</option>
            <option value="lower">all lowercase</option>
            <option value="title">Title Case</option>
            <option value="mixed">Mixed</option>
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="excl">Exclamation points</Label>
          <select
            id="excl"
            className="w-full h-9 rounded-md border bg-transparent px-3 text-sm"
            value={profile.exclamation_frequency}
            onChange={(e) =>
              update(
                "exclamation_frequency",
                e.target.value as VoiceProfile["exclamation_frequency"]
              )
            }
          >
            <option value="never">Never</option>
            <option value="rare">Rarely</option>
            <option value="occasional">Occasionally</option>
            <option value="frequent">Often</option>
          </select>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="emoji"
            checked={profile.uses_emoji}
            onCheckedChange={(c) => update("uses_emoji", c === true)}
          />
          <Label htmlFor="emoji" className="font-normal">
            I use emoji
          </Label>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="contractions"
            checked={profile.uses_contractions}
            onCheckedChange={(c) => update("uses_contractions", c === true)}
          />
          <Label htmlFor="contractions" className="font-normal">
            I use contractions
          </Label>
        </div>

        <ListField
          label="Phrases you actually use"
          hint="One per line."
          values={profile.common_phrases}
          onChange={(v) => update("common_phrases", v)}
        />

        <ListField
          label="Never write these"
          hint="One per line. These are rejected before a draft reaches you."
          values={profile.never_uses}
          onChange={(v) => update("never_uses", v)}
        />

        <Button onClick={handleSave} disabled={saving || !dirty} size="sm">
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          Save changes
        </Button>
      </CardContent>
    </Card>
  );
}

function ListField({
  label,
  hint,
  values,
  onChange,
}: {
  label: string;
  hint: string;
  values: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <textarea
        className="w-full min-h-20 rounded-md border bg-transparent px-3 py-2 text-sm"
        value={values.join("\n")}
        onChange={(e) =>
          onChange(
            e.target.value
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean)
          )
        }
      />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
