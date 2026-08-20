/**
 * Voice profile: read, regenerate, hand-edit.
 *
 * POST regenerates from real Bonzo messages (one analysis-model call).
 * PUT saves a hand-edited profile with no model call at all.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  collectOutboundMessages,
  extractVoiceProfile,
} from "@/lib/ai/voice-profile";
import { VOICE_PROFILE_SCHEMA, type VoiceProfile } from "@/lib/ai/voice-profile-types";

async function requireUser() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  return (data?.claims?.sub as string | undefined) ?? null;
}

export async function GET() {
  const userId = await requireUser();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceClient();
  const { data } = await service
    .from("user_settings")
    .select("voice_profile, voice_profile_generated_at")
    .eq("user_id", userId)
    .maybeSingle();

  return NextResponse.json({
    profile: data?.voice_profile ?? null,
    generatedAt: data?.voice_profile_generated_at ?? null,
  });
}

export async function POST() {
  const userId = await requireUser();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceClient();

  try {
    const messages = await collectOutboundMessages(service, userId);
    const { profile, sampleSize, usage } = await extractVoiceProfile(messages);

    const { error } = await service
      .from("user_settings")
      .update({
        voice_profile: profile,
        voice_profile_generated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);

    if (error) throw error;

    return NextResponse.json({ profile, sampleSize, usage });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to build voice profile";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Saves a hand-edited profile.
 *
 * Validated against the same schema the model is held to, so a typo in the UI
 * cannot put a shape into the drafting prompt that the renderer chokes on.
 */
export async function PUT(request: NextRequest) {
  const userId = await requireUser();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const profile = body?.profile as VoiceProfile | undefined;
  if (!profile) {
    return NextResponse.json({ error: "profile is required" }, { status: 400 });
  }

  const problems = validateProfileShape(profile);
  if (problems.length > 0) {
    return NextResponse.json({ error: problems.join("; ") }, { status: 400 });
  }

  const service = createServiceClient();
  const { error } = await service
    .from("user_settings")
    .update({
      voice_profile: profile,
      voice_profile_generated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ profile });
}

/** Minimal structural check against VOICE_PROFILE_SCHEMA. */
export function validateProfileShape(profile: VoiceProfile): string[] {
  const schema = VOICE_PROFILE_SCHEMA as {
    properties: Record<string, { type?: string; enum?: string[] }>;
    required: string[];
  };
  const problems: string[] = [];

  for (const key of schema.required) {
    if (!(key in profile)) problems.push(`${key} is missing`);
  }

  for (const [key, spec] of Object.entries(schema.properties)) {
    const value = (profile as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;

    if (spec.type === "array" && !Array.isArray(value)) {
      problems.push(`${key} must be a list`);
    }
    if (spec.type === "boolean" && typeof value !== "boolean") {
      problems.push(`${key} must be true or false`);
    }
    if (spec.type === "integer" && !Number.isInteger(value)) {
      problems.push(`${key} must be a whole number`);
    }
    if (spec.type === "string" && typeof value !== "string") {
      problems.push(`${key} must be text`);
    }
    if (spec.enum && typeof value === "string" && !spec.enum.includes(value)) {
      problems.push(`${key} must be one of: ${spec.enum.join(", ")}`);
    }
  }

  return problems;
}
