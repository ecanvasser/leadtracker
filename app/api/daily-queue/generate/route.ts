import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { calculateTodayActions, type QueueAction, type OutreachLogEntry, type BonzoCommEntry } from "@/lib/cadence/engine";
import { Contact } from "@/types/db";
import Anthropic from "@anthropic-ai/sdk";
import { getUserTimezone, localDate, leadAgeDays } from "@/lib/time";
import { getMortgageFields } from "@/lib/bonzo/client";
import { DRAFT_SYSTEM_BASE } from "@/lib/ai/prompts";

const QUEUE_DRAFT_SYSTEM = `${DRAFT_SYSTEM_BASE}

You will receive one or more actions. Each begins with an ACTION_INDEX line, then the prospect, their loan details, the recent conversation, and what action is due and why.

For each ACTION_INDEX you were given, return one JSON object:
- "action_index": the ACTION_INDEX for that action, copied exactly. One object per index, never two with the same index.
- "contact_id": the contact's ID
- "action_type": "sms", "email", or "call"
- "draft_message": the message text (null for calls)
- "email_subject": subject line (email only, null otherwise)
- "call_talking_points": bullet points (calls only, null otherwise)

Return a JSON array. No markdown, no backticks, no preamble.`;

interface InsightsCache {
  contact_id: string;
  bonzo_prospect_data: Record<string, unknown>;
  bonzo_communication: BonzoCommEntry[];
  ai_analysis: Record<string, unknown>;
}

interface DraftResult {
  /**
   * Index into the action list this draft answers.
   *
   * Drafts used to be keyed by `${contact_id}:${action_type}`, but a Day-0
   * lead gets channelHint ["sms","email","sms"] — two SMS actions — so both
   * queue rows resolved to the same draft and the identical text would go to
   * a brand new lead twice. The index is unique per action.
   */
  action_index: number;
  contact_id: string;
  action_type: string;
  draft_message: string | null;
  email_subject: string | null;
  call_talking_points: string | null;
}

function buildProspectContext(
  contact: Contact,
  cache: InsightsCache,
  action: QueueAction,
  actionIndex: number,
  timeZone: string
): string {
  const prospect = cache.bonzo_prospect_data;
  const comms = cache.bonzo_communication ?? [];
  const ageDays = leadAgeDays(contact.created_at, timeZone);

  const name = [prospect.first_name, prospect.last_name].filter(Boolean).join(" ") || contact.name;
  const mf = getMortgageFields(prospect);

  let ctx = `--- ACTION_INDEX: ${actionIndex} ---\n`;
  ctx += `PROSPECT: ${name} (contact ID: ${contact.id})\n`;
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

/**
 * Leads per drafting request.
 *
 * Held at 4 deliberately. Each call carries a fixed prefix — system prompt,
 * and later the voice profile and style exemplars — of roughly 2,300 tokens
 * that is resent per chunk. At 4 leads that overhead amortises sensibly; at 1
 * lead per chunk it dominates and roughly triples drafting cost. Failure
 * isolation is not a reason to shrink this: each chunk is already wrapped
 * independently below, and the job queue handles durability.
 */
const DRAFT_CHUNK_SIZE = 4;

/** Chunks in flight at once. Small enough to stay clear of rate limits. */
const DRAFT_CONCURRENCY = 3;

type PendingAction = { contact: Contact; action: QueueAction; cache: InsightsCache };

function fallbackDraft(
  { contact, action }: PendingAction,
  index: number
): DraftResult {
  return {
    action_index: index,
    contact_id: contact.id,
    action_type: action.actionType,
    draft_message:
      action.actionType === "call"
        ? null
        : "(Draft generation failed — write your own message)",
    email_subject: null,
    call_talking_points:
      action.actionType === "call"
        ? "• Open with a friendly greeting\n• Ask about their timeline\n• Offer to answer any questions"
        : null,
  };
}

function parseDraftResponse(text: string): DraftResult[] {
  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error("Draft response was not an array");
  return parsed as DraftResult[];
}

/**
 * Drafts one chunk. Retries once on a parse failure, then gives up and lets
 * the caller fall back for this chunk alone.
 */
async function draftChunk(
  chunk: { item: PendingAction; index: number }[],
  timeZone: string
): Promise<DraftResult[]> {
  const client = new Anthropic();

  const prompt = chunk
    .map(({ item, index }) =>
      buildProspectContext(item.contact, item.cache, item.action, index, timeZone)
    )
    .join("\n\n");

  // Scaled to the chunk rather than fixed at 4096. A truncated response is
  // what turned one bad generation into "(Draft generation failed)" for every
  // lead in the queue.
  const maxTokens = Math.min(8192, 1200 * chunk.length);

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: maxTokens,
        system: QUEUE_DRAFT_SYSTEM,
        messages: [{ role: "user", content: prompt }],
      });
      const text =
        response.content[0]?.type === "text" ? response.content[0].text : "";
      if (response.stop_reason === "max_tokens") {
        throw new Error("Draft response hit max_tokens and was truncated");
      }
      return parseDraftResponse(text);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

/**
 * Drafts every pending action in independent chunks.
 *
 * The previous implementation concatenated every prospect into a single
 * request and JSON.parsed the whole response, so any truncation replaced
 * *every* draft with the failure placeholder. Now a chunk that fails degrades
 * only its own leads.
 */
async function generateDrafts(
  allActions: PendingAction[],
  timeZone: string
): Promise<DraftResult[]> {
  const indexed = allActions.map((item, index) => ({ item, index }));
  const chunks: (typeof indexed)[] = [];
  for (let i = 0; i < indexed.length; i += DRAFT_CHUNK_SIZE) {
    chunks.push(indexed.slice(i, i + DRAFT_CHUNK_SIZE));
  }

  const results: DraftResult[] = [];
  let cursor = 0;

  async function worker() {
    while (cursor < chunks.length) {
      const chunk = chunks[cursor++];
      try {
        const drafted = await draftChunk(chunk, timeZone);
        // Keep only indices this chunk was actually asked for, so a confused
        // response cannot clobber another chunk's drafts.
        const allowed = new Set(chunk.map((c) => c.index));
        const kept = drafted.filter((d) => allowed.has(d.action_index));
        const missing = chunk.filter(
          (c) => !kept.some((d) => d.action_index === c.index)
        );
        if (missing.length > 0) {
          console.warn(
            `[daily-queue/generate] chunk returned ${kept.length}/${chunk.length} drafts; ` +
              `falling back for indices ${missing.map((m) => m.index).join(", ")}`
          );
        }
        results.push(
          ...kept,
          ...missing.map(({ item, index }) => fallbackDraft(item, index))
        );
      } catch (e) {
        console.error(
          `[daily-queue/generate] chunk failed for indices ` +
            `${chunk.map((c) => c.index).join(", ")}: ` +
            `${e instanceof Error ? e.message : String(e)}`
        );
        results.push(
          ...chunk.map(({ item, index }) => fallbackDraft(item, index))
        );
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(DRAFT_CONCURRENCY, chunks.length) }, worker)
  );

  return results;
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

  // 0.6: today's already-actioned rows are load-bearing. handleGenerate(true)
  // used to delete every row for today and reinsert everything as pending,
  // wiping the progress bar, sent counts and skips.
  const { data: existingRows } = await serviceClient
    .from("daily_queue")
    .select("id, contact_id, action_type, status, priority_rank")
    .eq("user_id", userId)
    .eq("queue_date", todayStr);

  const actionedRows = (existingRows ?? []).filter((r) => r.status !== "pending");

  // How many actions of each kind are already spoken for today, so a refresh
  // cannot resurrect something already sent, skipped or marked done.
  const actionedCount = new Map<string, number>();
  for (const row of actionedRows) {
    const key = `${row.contact_id}:${row.action_type}`;
    actionedCount.set(key, (actionedCount.get(key) ?? 0) + 1);
  }

  const allActions: PendingAction[] = [];

  for (const contact of contacts as Contact[]) {
    const history = outreachByContact[contact.id] ?? [];
    const cache = insightsByContact[contact.id];
    const comms = cache?.bonzo_communication ?? [];

    const actions = calculateTodayActions(contact, history, comms, { timeZone });

    for (const action of actions) {
      // Drop this action if an equivalent one was already actioned today.
      const key = `${contact.id}:${action.actionType}`;
      const covered = actionedCount.get(key) ?? 0;
      if (covered > 0) {
        actionedCount.set(key, covered - 1);
        continue;
      }
      allActions.push({
        contact,
        action,
        cache: cache ?? { contact_id: contact.id, bonzo_prospect_data: {}, bonzo_communication: [], ai_analysis: {} },
      });
    }
  }

  if (allActions.length === 0) {
    // Clear only what was still pending; anything actioned stays on the board.
    await serviceClient
      .from("daily_queue")
      .delete()
      .eq("user_id", userId)
      .eq("queue_date", todayStr)
      .eq("status", "pending");

    const { data: remaining } = await serviceClient
      .from("daily_queue")
      .select("*, contacts(name, loan_type, crm, stage, created_at, insights_enabled)")
      .eq("user_id", userId)
      .eq("queue_date", todayStr)
      .order("priority_rank", { ascending: true });

    return NextResponse.json({ queue: remaining ?? [], generated: true });
  }

  allActions.sort((a, b) => {
    if (b.action.priorityScore !== a.action.priorityScore) {
      return b.action.priorityScore - a.action.priorityScore;
    }
    return new Date(a.contact.created_at).getTime() - new Date(b.contact.created_at).getTime();
  });

  const drafts = await generateDrafts(allActions, timeZone);

  const draftMap = new Map<number, DraftResult>();
  for (const d of drafts) {
    if (typeof d.action_index !== "number") continue;
    // First write wins, so a duplicated index from the model cannot overwrite
    // a draft that was already matched to its action.
    if (!draftMap.has(d.action_index)) draftMap.set(d.action_index, d);
  }

  // Only pending rows are replaced. Actioned rows are left exactly as they are.
  await serviceClient
    .from("daily_queue")
    .delete()
    .eq("user_id", userId)
    .eq("queue_date", todayStr)
    .eq("status", "pending");

  // New rows rank after everything already actioned, so the progress bar keeps
  // counting up rather than resetting.
  const rankOffset = actionedRows.length;

  const queueRows = allActions.map(({ contact, action }, idx) => {
    const draft = draftMap.get(idx);
    let draftMessage = draft?.draft_message ?? null;
    if (draft?.email_subject && draftMessage) {
      draftMessage = `Subject: ${draft.email_subject}\n\n${draftMessage}`;
    }

    return {
      user_id: userId,
      contact_id: contact.id,
      queue_date: todayStr,
      priority_rank: rankOffset + idx + 1,
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
