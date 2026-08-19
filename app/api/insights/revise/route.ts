import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import Anthropic from "@anthropic-ai/sdk";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { drafts, instructions } = await request.json();

  if (!drafts || !instructions?.trim()) {
    return NextResponse.json(
      { error: "drafts and instructions are required" },
      { status: 400 }
    );
  }

  try {
    const client = new Anthropic();

    const currentDrafts = drafts
      .map(
        (d: { channel: string; subject?: string; body: string }, i: number) =>
          `Draft ${i + 1} (${d.channel})${d.subject ? ` — Subject: ${d.subject}` : ""}:\n${d.body}`
      )
      .join("\n\n");

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: `You are revising draft follow-up messages for a mortgage broker. You will receive the current drafts and the broker's revision instructions. Produce revised drafts that incorporate the broker's feedback while keeping the same channel and overall intent. Match the broker's writing style from the original drafts.

Respond ONLY with a JSON array of objects, each with "channel" (sms or email), "subject" (for email only, omit for sms), and "body". No markdown, no backticks, no preamble.`,
      messages: [
        {
          role: "user",
          content: `CURRENT DRAFTS:\n${currentDrafts}\n\nREVISION INSTRUCTIONS:\n${instructions}`,
        },
      ],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    const cleaned = text
      .replace(/^```json\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    const revised = JSON.parse(cleaned);

    return NextResponse.json({ drafts: revised });
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "Failed to revise drafts";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
