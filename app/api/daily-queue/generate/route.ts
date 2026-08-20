import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { calculateTodayActions, type QueueAction, type OutreachLogEntry, type BonzoCommEntry } from "@/lib/cadence/engine";
import { Contact } from "@/types/db";
import Anthropic from "@anthropic-ai/sdk";
import { getUserTimezone, localDate } from "@/lib/time";

const QUEUE_DRAFT_SYSTEM = `You are a sales assistant for a mortgage broker who specializes in speed-to-lead outreach. You're generating today's outreach messages for multiple prospects.

For each prospect, you'll receive:
- Their profile and mortgage details.
- The full conversation history.
- What action is needed (SMS, email, or call) and why (e.g. "Day 1 — 2nd touch", "Unanswered reply from yesterday").
- The cadence context (how old the lead is, how many touches today).

Rules:
1. TONE MATCHING IS CRITICAL. Study the broker's previous outbound messages and replicate their exact style — greetings, emoji usage, sentence length, formality, punctuation habits. The prospect must not be able to tell an AI wrote it.
2. Each message must feel natural in the context of the conversation. Don't repeat points already covered. Don't be redundant with a message sent hours ago.
3. Day 1 messages should create urgency without being pushy — the prospect just opted in, they're actively shopping. Acknowledge that, offer immediate value (rates, a quick call, answers to questions).
4. As lead age increases, messages shift from urgency to value and persistence — share market insights, rate updates, check in on their timeline, ask if they've found a property.
5. For CALLS, don't write a message. Write 3–4 short bullet-point talking points: what to open with, what to ask about, what to offer. Keep them conversational, not scripted.
6. SMS should be short (2–4 sentences max). Emails can be slightly longer but still concise.
7. Never be desperate or apologetic. Be confident, helpful, and assume the sale.

For each prospect, return a JSON object with:
- "contact_id": the contact's ID
- "action_type": "sms", "email", or "call"
- "draft_message": the message text (null for calls)
- "email_subject": subject line (only for email actions, null otherwise)
- "call_talking_points": bullet points (only for call actions, null otherwise)

Return a JSON array of all prospect objects. No markdown, no backticks, no preamble.`;

interface InsightsCache {
  contact_id: string;
  bonzo_prospect_data: Record<string, unknown>;
  bonzo_communication: BonzoCommEntry[];
  ai_analysis: Record<string, unknown>;
}

interface DraftResult {
  contact_id: string;
  action_type: string;
  draft_message: string | null;
  email_subject: string | null;
  call_talking_points: string | null;
}

function buildProspectContext(
  contact: Contact,
  cache: InsightsCache,
  action: QueueAction
): string {
  const prospect = cache.bonzo_prospect_data;
  const comms = cache.bonzo_communication ?? [];
  const ageDays = Math.floor(
    (Date.now() - new Date(contact.created_at).getTime()) / (1000 * 60 * 60 * 24)
  );

  const name = [prospect.first_name, prospect.last_name].filter(Boolean).join(" ") || contact.name;
  const mf = prospect.mortgage_fields as Record<string, string> | undefined;

  let ctx = `--- PROSPECT: ${name} (ID: ${contact.id}) ---\n`;
  ctx += `Lead age: Day ${ageDays + 1}\n`;
  ctx += `Action needed: ${action.actionType.toUpperCase()} — ${action.priorityReason}\n`;
  if (action.touchLabel) ctx += `Cadence: ${action.touchLabel}\n`;

  if (mf) {
    const fields = Object.entries(mf)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    if (fields) ctx += `Mortgage details: ${fields}\n`;
  }

  if (comms.length > 0) {
    const sorted = [...comms].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    const recent = sorted.slice(-15);
    const thread = recent.map((c) => {
      const dir = c.direction === "outbound" ? "BROKER" : "PROSPECT";
      return `[${c.created_at}] ${dir}: ${c.content?.trim() || "(no content)"}`;
    }).join("\n");
    ctx += `\nRecent conversation:\n${thread}\n`;
  } else {
    ctx += `\nNo conversation history yet — this is a first outreach.\n`;
  }

  return ctx;
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = authData.claims.sub as string;
  const serviceClient = createServiceClient();

  // "Today" is the broker's local day, resolved once and reused everywhere
  // below. Computing it per-query with toISOString() rolled the queue over at
  // 5 PM Pacific and silently discarded the afternoon block.
  const timeZone = await getUserTimezone(userId);
  const todayStr = localDate(new Date(), timeZone);

  const { data: existingQueue } = await serviceClient
    .from("daily_queue")
    .select("created_at")
    .eq("user_id", userId)
    .eq("queue_date", todayStr)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingQueue) {
    const lastGen = new Date(existingQueue.created_at).getTime();
    const fifteenMin = 15 * 60 * 1000;
    if (Date.now() - lastGen < fifteenMin) {
      const body = await request.json().catch(() => ({}));
      if (!body.force) {
        return NextResponse.json(
          { error: "Queue was generated less than 15 minutes ago. Pass force: true to override." },
          { status: 429 }
        );
      }
    }
  }

  const { data: contacts } = await serviceClient
    .from("contacts")
    .select("*")
    .eq("user_id", userId)
    .eq("insights_enabled", true)
    .eq("stage", "hot_lead");

  if (!contacts || contacts.length === 0) {
    return NextResponse.json({ queue: [], generated: true });
  }

  const contactIds = contacts.map((c) => c.id);

  const [{ data: outreachData }, { data: insightsData }] = await Promise.all([
    serviceClient
      .from("outreach_log")
      .select("*")
      .in("contact_id", contactIds)
      .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .order("created_at", { ascending: true }),
    serviceClient
      .from("insights_cache")
      .select("contact_id, bonzo_prospect_data, bonzo_communication, ai_analysis")
      .in("contact_id", contactIds),
  ]);

  const outreachByContact: Record<string, OutreachLogEntry[]> = {};
  for (const entry of (outreachData ?? []) as OutreachLogEntry[]) {
    if (!outreachByContact[entry.contact_id]) outreachByContact[entry.contact_id] = [];
    outreachByContact[entry.contact_id].push(entry);
  }

  const insightsByContact: Record<string, InsightsCache> = {};
  for (const cache of (insightsData ?? []) as InsightsCache[]) {
    insightsByContact[cache.contact_id] = cache;
  }

  const allActions: { contact: Contact; action: QueueAction; cache: InsightsCache }[] = [];

  for (const contact of contacts as Contact[]) {
    const history = outreachByContact[contact.id] ?? [];
    const cache = insightsByContact[contact.id];
    const comms = cache?.bonzo_communication ?? [];

    const actions = calculateTodayActions(contact, history, comms, { timeZone });

    for (const action of actions) {
      allActions.push({
        contact,
        action,
        cache: cache ?? { contact_id: contact.id, bonzo_prospect_data: {}, bonzo_communication: [], ai_analysis: {} },
      });
    }
  }

  if (allActions.length === 0) {
    await serviceClient
      .from("daily_queue")
      .delete()
      .eq("user_id", userId)
      .eq("queue_date", todayStr);

    return NextResponse.json({ queue: [], generated: true });
  }

  allActions.sort((a, b) => {
    if (b.action.priorityScore !== a.action.priorityScore) {
      return b.action.priorityScore - a.action.priorityScore;
    }
    return new Date(a.contact.created_at).getTime() - new Date(b.contact.created_at).getTime();
  });

  let drafts: DraftResult[] = [];
  try {
    const batchPrompt = allActions
      .map(({ contact, action, cache }) => buildProspectContext(contact, cache, action))
      .join("\n\n");

    const client = new Anthropic();
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: QUEUE_DRAFT_SYSTEM,
      messages: [{ role: "user", content: batchPrompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    drafts = JSON.parse(cleaned) as DraftResult[];
  } catch {
    drafts = allActions.map(({ contact, action }) => ({
      contact_id: contact.id,
      action_type: action.actionType,
      draft_message: action.actionType === "call" ? null : "(Draft generation failed — write your own message)",
      email_subject: null,
      call_talking_points: action.actionType === "call" ? "• Open with a friendly greeting\n• Ask about their timeline\n• Offer to answer any questions" : null,
    }));
  }

  const draftMap = new Map<string, DraftResult>();
  for (const d of drafts) {
    draftMap.set(`${d.contact_id}:${d.action_type}`, d);
  }

  await serviceClient
    .from("daily_queue")
    .delete()
    .eq("user_id", userId)
    .eq("queue_date", todayStr);

  const queueRows = allActions.map(({ contact, action }, idx) => {
    const draft = draftMap.get(`${contact.id}:${action.actionType}`);
    let draftMessage = draft?.draft_message ?? null;
    if (draft?.email_subject && draftMessage) {
      draftMessage = `Subject: ${draft.email_subject}\n\n${draftMessage}`;
    }

    return {
      user_id: userId,
      contact_id: contact.id,
      queue_date: todayStr,
      priority_rank: idx + 1,
      priority_reason: action.priorityReason,
      action_type: action.actionType,
      draft_message: draftMessage,
      call_talking_points: draft?.call_talking_points ?? null,
      status: "pending",
    };
  });

  const { error: insertErr } = await serviceClient
    .from("daily_queue")
    .insert(queueRows);

  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  const { data: queue } = await serviceClient
    .from("daily_queue")
    .select("*, contacts(name, loan_type, crm, stage, created_at, insights_enabled)")
    .eq("user_id", userId)
    .eq("queue_date", todayStr)
    .order("priority_rank", { ascending: true });

  return NextResponse.json({ queue: queue ?? [], generated: true });
}
