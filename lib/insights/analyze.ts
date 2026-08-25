import Anthropic from "@anthropic-ai/sdk";
import { ANALYSIS_SYSTEM } from "@/lib/ai/prompts";
import {
  isOutbound,
  getMortgageFields,
  type BonzoProspect,
  type BonzoCommunication,
  type BonzoNote,
} from "@/lib/bonzo/client";

export interface AiAnalysis {
  status_read: string;
  suggested_next_step: string;
  /**
   * Populated by lib/ai/draft.ts, not by this module.
   *
   * analyze.ts used to generate its own drafts with its own prompt and no
   * validation, in parallel with the queue generating different drafts for the
   * same lead. There is now one drafting path and this field is filled from
   * it. Kept on the analysis object so the contact page's shape is unchanged.
   */
  draft_messages: {
    channel: "sms" | "email";
    subject?: string;
    body: string;
  }[];
  suggested_todos: {
    title: string;
  }[];
}

const SYSTEM_PROMPT = `${ANALYSIS_SYSTEM}

Produce a JSON object with these sections:

1. "status_read" — 2-3 sentences on where things actually stand. When was the last contact, who spoke last, is the prospect responding, what is the open question. If the honest answer is "this has gone quiet and nothing has changed", write that.

2. "suggested_next_step" — 1-2 sentences. What to do and why, referencing specific evidence. "Hold and do not contact" is a valid answer when nothing has changed.

3. "suggested_todos" — 0-3 concrete to-dos, each with a "title". Only things the conversation actually calls for.

Respond ONLY with the JSON object. No markdown, no backticks, no preamble.`;

function buildUserMessage(
  prospect: BonzoProspect,
  communications: BonzoCommunication[],
  notes: BonzoNote[]
): string {
  const name = [prospect.first_name, prospect.last_name]
    .filter(Boolean)
    .join(" ");
  const mf = getMortgageFields(prospect);

  let msg = `PROSPECT PROFILE:
Name: ${name || "Unknown"}
Email: ${prospect.email || "N/A"}
Phone: ${prospect.phone || "N/A"}
Status: ${prospect.status || "N/A"}`;
  // Bonzo's own pipeline stage used to be interpolated here. It is gone with
  // the rest of the pipeline fields: the app does not read Bonzo pipelines,
  // and feeding one to the classifier invited exactly the mirroring D4 ruled
  // out. LeadTracker's own stage is the only stage that means anything here.

  if (mf) {
    // Field names transcribed from Bonzo's OpenAPI document. The previous list
    // included annual_income, employment_status and agent_* — none of which
    // Bonzo returns, so they were always blank.
    const fields = [
      ["Loan Type", mf.loan_type],
      ["Loan Purpose", mf.loan_purpose],
      ["Loan Program", mf.loan_program],
      ["Loan Amount", mf.loan_amount],
      ["Down Payment", mf.down_payment],
      ["Credit Score", mf.credit_score],
      ["Property Address", mf.property_address],
      ["Property City", mf.property_city],
      ["Property State", mf.property_state],
      ["Property Zip", mf.property_zip],
      ["Property Value", mf.property_value],
      ["Found Home", mf.found_home === 1 ? "Yes" : mf.found_home === 0 ? "No" : null],
      ["Bankruptcy", mf.bankruptcy === 1 ? "Yes" : mf.bankruptcy === 0 ? "No" : null],
    ]
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");

    if (fields) {
      msg += `\n\nMORTGAGE DETAILS:\n${fields}`;
    }
  }

  if (communications.length > 0) {
    const sorted = [...communications].sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    const thread = sorted
      .map((c) => {
        const dir = isOutbound(c.direction) ? "OUTBOUND" : "INBOUND";
        const content = c.content?.trim() || "(no content)";
        return `[${c.created_at}] ${dir} (${c.type}): ${content}`;
      })
      .join("\n");
    msg += `\n\nCOMMUNICATION HISTORY (oldest to newest):\n${thread}`;
  } else {
    msg += "\n\nCOMMUNICATION HISTORY:\nNo messages yet.";
  }

  if (notes.length > 0) {
    const noteText = notes
      .map((n) => `[${n.created_at}]: ${n.content}`)
      .join("\n");
    msg += `\n\nINTERNAL NOTES:\n${noteText}`;
  }

  msg += "\n\nAnalyze this prospect and provide your recommendations.";
  return msg;
}

export async function analyzeProspect(
  prospect: BonzoProspect,
  communications: BonzoCommunication[],
  notes: BonzoNote[],
  /**
   * Called with what the request cost. Optional so the pure paths and tests
   * stay unchanged; the worker always passes it, because usage this function
   * used to drop is most of the spend the budget is supposed to govern.
   */
  onUsage?: (usage: {
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    latency_ms: number;
  }) => void
): Promise<AiAnalysis> {
  const startedAt = Date.now();
  const client = new Anthropic();

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildUserMessage(prospect, communications, notes),
      },
    ],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  const parsed = JSON.parse(cleaned) as AiAnalysis;

  if (!parsed.status_read || !parsed.suggested_next_step) {
    throw new Error("Invalid AI analysis response shape");
  }

  // Drafting is not this module's job. The caller fills draft_messages from
  // lib/ai/draft.ts so the contact page and the queue produce the same text
  // under the same constraints.
  onUsage?.({
    model: response.model,
    input_tokens: response.usage.input_tokens ?? 0,
    output_tokens: response.usage.output_tokens ?? 0,
    cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    latency_ms: Date.now() - startedAt,
  });

  return { ...parsed, draft_messages: [] };
}
