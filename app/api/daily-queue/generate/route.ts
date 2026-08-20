import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { planLead, type LeadPlan, type QueueAction, type OutreachLogEntry, type BonzoCommEntry } from "@/lib/cadence/engine";
import { resolveCadenceConfig, type CadenceConfig } from "@/lib/cadence/config";
import type { LeadState } from "@/lib/insights/lead-state";
import { Contact } from "@/types/db";
import { getUserTimezone, localDate, leadAgeDays } from "@/lib/time";
import { getMortgageFields } from "@/lib/bonzo/client";
import { callModel, DRAFT_TEMPERATURE, modelFor, type ModelUsage } from "@/lib/ai/models";
import { buildStablePrefix } from "@/lib/ai/prompts";
import { buildConstraintBlock, type DraftContext, type Violation } from "@/lib/ai/validate";
import {
  buildGroundingCorpus,
  buildRetryInstruction,
  checkDraft,
  hasIntroducedSelf,
} from "@/lib/ai/draft-validation";
import { exemplarsFor } from "@/lib/ai/voice-profile";
import type { VoiceProfile } from "@/lib/ai/voice-profile-types";

/**
 * Bumped whenever the drafting prompt changes in a way that could alter
 * output. Recorded in every decision_trace so a bad suggestion can be tied to
 * the exact wording that produced it.
 */
export const DRAFT_PROMPT_VERSION = "1.3.0";

/**
 * Output contract, appended after the stable prefix.
 *
 * Kept separate from the tone and constraint blocks so the stable prefix stays
 * byte-identical across leads and remains cacheable.
 */
const DRAFT_OUTPUT_CONTRACT = `You will receive one or more actions. Each begins with an ACTION_INDEX line, then the prospect, their loan details, the recent conversation, and what action is due and why.

For each ACTION_INDEX you were given, return one JSON object:
- "action_index": the ACTION_INDEX for that action, copied exactly. One object per index, never two with the same index.
- "contact_id": the contact's ID
- "action_type": "sms", "email", or "call"
- "draft_message": the message text (null for calls)
- "email_subject": subject line (email only, null otherwise)
- "call_talking_points": bullet points (calls only, null otherwise)

Return a JSON array. No markdown, no backticks, no preamble.`;

/**
 * Assembles the drafting system prompt for this user.
 *
 * Fixed order — tone, constraints, voice profile, exemplars — then the output
 * contract. Nothing per-lead appears here; per-lead context goes in the user
 * message so the prefix stays cacheable.
 */
function buildDraftSystem(settings: DraftSettings, exemplars: string[]): string {
  return [
    buildStablePrefix({
      constraints: buildConstraintBlock({
        brokerName: settings.brokerName,
        brokerCompany: settings.brokerCompany,
        allowEmoji: settings.voiceProfile?.uses_emoji ?? false,
      }),
      voiceProfile: settings.voiceProfile,
      exemplars,
    }),
    DRAFT_OUTPUT_CONTRACT,
  ].join("\n\n");
}

interface InsightsCache {
  contact_id: string;
  bonzo_prospect_data: Record<string, unknown>;
  bonzo_communication: BonzoCommEntry[];
  ai_analysis: Record<string, unknown>;
  lead_state: LeadState | null;
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
  /** Populated by validation; not returned by the model. */
  violations?: Violation[];
  validated?: boolean;
  /** Populated after generation; not returned by the model. */
  usage?: ModelUsage;
  attempts?: number;
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

type PendingAction = { contact: Contact; action: QueueAction; cache: InsightsCache; plan: LeadPlan };

/** Per-user drafting configuration, read once per generation. */
export interface DraftSettings {
  brokerName: string;
  brokerCompany: string;
  voiceProfile: VoiceProfile | null;
  timeZone: string;
}

/**
 * Builds the validation context for one action.
 *
 * isFirstOutbound comes from real Bonzo history rather than lead age: a
 * day-old lead he has already replied to has been introduced, and a month-old
 * lead he never answered has not.
 */
function draftContextFor(
  item: PendingAction,
  settings: DraftSettings
): DraftContext {
  const comms = item.cache.bonzo_communication ?? [];
  const prospect = item.cache.bonzo_prospect_data;
  const firstName =
    (prospect?.first_name as string | undefined)?.trim() ||
    item.contact.name.split(" ")[0] ||
    "there";

  return {
    channel: item.action.actionType === "email" ? "email" : "sms",
    firstName,
    brokerName: settings.brokerName,
    brokerCompany: settings.brokerCompany,
    isFirstOutbound: !hasIntroducedSelf(
      comms,
      settings.brokerName,
      settings.brokerCompany
    ),
    allowEmoji: settings.voiceProfile?.uses_emoji ?? false,
    neverUses: settings.voiceProfile?.never_uses ?? [],
    groundingCorpus: buildGroundingCorpus(prospect, comms),
  };
}

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
async function draftChunkWithUsage(
  chunk: { item: PendingAction; index: number }[],
  settings: DraftSettings,
  retryInstruction: string | null = null
): Promise<{ drafts: DraftResult[]; usage: ModelUsage }> {
  // Style exemplars: this prospect's own recent outbound messages if there are
  // any, since matching the register of an existing thread matters more than
  // matching his general voice. Falls back to the chunk's other threads.
  const perProspect = exemplarsFor(chunk[0]?.item.cache.bonzo_communication ?? []);
  const exemplars =
    perProspect.length > 0
      ? perProspect
      : exemplarsFor(
          chunk.flatMap((c) => c.item.cache.bonzo_communication ?? [])
        );

  const prompt = chunk
    .map(({ item, index }) =>
      buildProspectContext(item.contact, item.cache, item.action, index, settings.timeZone)
    )
    .join("\n\n");

  const userContent = retryInstruction
    ? `${prompt}\n\n${retryInstruction}`
    : prompt;

  // Scaled to the chunk rather than fixed at 4096. A truncated response is
  // what turned one bad generation into "(Draft generation failed)" for every
  // lead in the queue.
  const maxTokens = Math.min(8192, 1500 * chunk.length);

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await callModel<DraftResult[]>({
        role: "draft",
        system: buildDraftSystem(settings, exemplars),
        maxTokens,
        // Sent only if the configured model still accepts sampling; the
        // current default does not. See lib/ai/models.ts.
        temperature: DRAFT_TEMPERATURE,
        messages: [{ role: "user", content: userContent }],
      });

      if (result.truncated) {
        throw new Error("Draft response hit max_tokens and was truncated");
      }
      const parsed = result.parsed ?? parseDraftResponse(result.text);
      if (!Array.isArray(parsed)) throw new Error("Draft response was not an array");
      return { drafts: parsed, usage: result.usage };
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
  settings: DraftSettings
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
      const allowed = new Set(chunk.map((c) => c.index));
      const byIndex = new Map(chunk.map((c) => [c.index, c]));

      try {
        const first = await draftChunkWithUsage(chunk, settings);
        let drafted = first.drafts.filter((d) => allowed.has(d.action_index));
        for (const d of drafted) {
          d.usage = first.usage;
          d.attempts = 1;
        }

        // Validate every draft against the 1.3 constraints.
        let failures = collectFailures(drafted, byIndex, settings);

        // Exactly one corrective retry, covering only the failing actions.
        // Never a loop: an over-strict validator must degrade into showing
        // something flagged, not into spending tokens until it passes.
        if (failures.length > 0) {
          const retryChunk = failures
            .map((f) => byIndex.get(f.index))
            .filter((c): c is { item: PendingAction; index: number } => Boolean(c));

          console.warn(
            `[daily-queue/generate] ${failures.length} draft(s) failed validation; ` +
              `retrying once. Reasons: ` +
              failures
                .flatMap((f) => f.violations.map((v) => v.rule))
                .join(", ")
          );

          try {
            const second = await draftChunkWithUsage(
              retryChunk,
              settings,
              buildRetryInstruction(failures)
            );
            const retried = second.drafts.filter((d) => allowed.has(d.action_index));
            for (const d of retried) {
              d.usage = second.usage;
              d.attempts = 2;
            }

            const replaced = new Map(retried.map((d) => [d.action_index, d]));
            drafted = drafted.map((d) => replaced.get(d.action_index) ?? d);
            failures = collectFailures(drafted, byIndex, settings);
          } catch (e) {
            console.error(
              `[daily-queue/generate] corrective retry failed: ` +
                `${e instanceof Error ? e.message : String(e)}`
            );
          }
        }

        // Annotate whatever we ended up with. Anything still failing is shown
        // to the broker flagged rather than withheld.
        const stillFailing = new Map(failures.map((f) => [f.index, f.violations]));
        for (const d of drafted) {
          const violations = stillFailing.get(d.action_index) ?? [];
          d.violations = violations;
          d.validated = violations.length === 0;
          if (violations.length > 0) {
            console.warn(
              `[daily-queue/generate] surfacing unvalidated draft for action ` +
                `${d.action_index}: ${violations.map((v) => v.rule).join(", ")}`
            );
          }
        }

        const missing = chunk.filter(
          (c) => !drafted.some((d) => d.action_index === c.index)
        );
        if (missing.length > 0) {
          console.warn(
            `[daily-queue/generate] chunk returned ${drafted.length}/${chunk.length} drafts; ` +
              `falling back for indices ${missing.map((m) => m.index).join(", ")}`
          );
        }
        results.push(
          ...drafted,
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

/** Validates a chunk's drafts, returning only those that broke a rule. */
function collectFailures(
  drafted: DraftResult[],
  byIndex: Map<number, { item: PendingAction; index: number }>,
  settings: DraftSettings
): { index: number; violations: Violation[] }[] {
  const failures: { index: number; violations: Violation[] }[] = [];

  for (const d of drafted) {
    const entry = byIndex.get(d.action_index);
    if (!entry) continue;
    const violations = checkDraft(
      d.draft_message,
      draftContextFor(entry.item, settings)
    );
    if (violations.length > 0) {
      failures.push({ index: d.action_index, violations });
    }
  }

  return failures;
}

/**
 * Assembles the audit record for one queue item.
 *
 * Everything here answers "why did this fire, and what did it cost". The
 * shape is intentionally flat and readable — this is meant to be looked at by
 * a person staring at a bad suggestion, not parsed by anything.
 */
function buildDecisionTrace(input: {
  action: QueueAction;
  plan: LeadPlan;
  draft: DraftResult | undefined;
  leadState: LeadState | null;
  cadenceConfig: CadenceConfig;
  timeZone: string;
}): Record<string, unknown> {
  const { action, plan, draft, leadState, cadenceConfig, timeZone } = input;

  return {
    // Which lane and which rule inside it.
    lane: action.lane,
    rule_fired: plan.inputs.rule ?? null,
    lead_age_days: plan.ageDays,

    // The priority arithmetic, so a surprising rank can be traced.
    priority: {
      score: action.priorityScore,
      reason: action.priorityReason,
      base_score: plan.inputs.base_score ?? null,
      is_overdue: plan.inputs.is_overdue ?? false,
      target_messages: plan.inputs.target_messages ?? null,
      target_calls: plan.inputs.target_calls ?? null,
    },

    // What the classifier believed, and what it could prove.
    lead_state: leadState
      ? {
          lead_temp: leadState.lead_temp,
          blocker: leadState.blocker,
          blocker_confidence: leadState.blocker_confidence,
          blocker_evidence: leadState.blocker_evidence,
          why_now: leadState.why_now,
          recommended_action: leadState.recommended_action,
        }
      : null,

    // Raw engine inputs, verbatim.
    inputs: plan.inputs,

    // The cadence constants in force at generation time — a trace read weeks
    // later is misleading if the settings have since changed.
    cadence_config: cadenceConfig,
    timezone: timeZone,

    // Drafting: model, prompt version, validation outcome and spend.
    drafting: draft
      ? {
          model: draft.usage?.model ?? modelFor("draft"),
          prompt_version: DRAFT_PROMPT_VERSION,
          temperature: draft.usage?.temperature ?? null,
          attempts: draft.attempts ?? null,
          validated: draft.validated ?? null,
          violations: draft.violations ?? [],
          input_tokens: draft.usage?.input_tokens ?? null,
          output_tokens: draft.usage?.output_tokens ?? null,
          cache_read_input_tokens: draft.usage?.cache_read_input_tokens ?? null,
          latency_ms: draft.usage?.latency_ms ?? null,
        }
      : { model: null, prompt_version: DRAFT_PROMPT_VERSION, note: "no draft produced" },

    generated_at: new Date().toISOString(),
  };
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

  // Broker identity and voice profile drive both the prompt and the validator,
  // so they are read once and threaded through drafting.
  const { data: userSettings } = await serviceClient
    .from("user_settings")
    .select("broker_display_name, broker_company, voice_profile, cadence_config")
    .eq("user_id", userId)
    .maybeSingle();

  const cadenceConfig: CadenceConfig = resolveCadenceConfig(
    userSettings?.cadence_config
  );

  const draftSettings: DraftSettings = {
    brokerName: userSettings?.broker_display_name ?? "Eddie Canvasser",
    brokerCompany: userSettings?.broker_company ?? "E Mortgage Capital",
    voiceProfile: (userSettings?.voice_profile as VoiceProfile | null) ?? null,
    timeZone,
  };

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
      .select("contact_id, bonzo_prospect_data, bonzo_communication, ai_analysis, lead_state")
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
  /** Leads the engine deliberately stayed quiet on, surfaced in the response. */
  const held: { contactId: string; name: string; reason: string; recommendAdverse: boolean }[] = [];

  for (const contact of contacts as Contact[]) {
    const history = outreachByContact[contact.id] ?? [];
    const cache = insightsByContact[contact.id];
    const comms = cache?.bonzo_communication ?? [];

    const plan = planLead(contact, history, comms, {
      timeZone,
      config: cadenceConfig,
      leadState: cache?.lead_state ?? null,
    });

    if (plan.hold) {
      held.push({
        contactId: contact.id,
        name: contact.name,
        reason: plan.holdReason ?? "No action due",
        recommendAdverse: plan.recommendAdverse,
      });
    }

    for (const action of plan.actions) {
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
        plan,
        cache: cache ?? {
          contact_id: contact.id,
          bonzo_prospect_data: {},
          bonzo_communication: [],
          ai_analysis: {},
          lead_state: null,
        },
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

    // An empty queue with no explanation is indistinguishable from a broken
    // one. When the engine deliberately stayed quiet on every lead, say so and
    // say why — that is the whole point of allowing it to do nothing.
    return NextResponse.json({ queue: remaining ?? [], generated: true, held });
  }

  allActions.sort((a, b) => {
    if (b.action.priorityScore !== a.action.priorityScore) {
      return b.action.priorityScore - a.action.priorityScore;
    }
    return new Date(a.contact.created_at).getTime() - new Date(b.contact.created_at).getTime();
  });

  const drafts = await generateDrafts(allActions, draftSettings);

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

  const queueRows = allActions.map(({ contact, action, plan, cache }, idx) => {
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
      lane: action.lane,
      touch_label: action.touchLabel,
      decision_trace: buildDecisionTrace({
        action,
        plan,
        draft,
        leadState: cache.lead_state,
        cadenceConfig,
        timeZone,
      }),
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

  return NextResponse.json({ queue: queue ?? [], generated: true, held });
}
