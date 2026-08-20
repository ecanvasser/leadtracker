import Anthropic from "@anthropic-ai/sdk";
import { ANALYSIS_SYSTEM } from "@/lib/ai/prompts";
import {
  getMortgageFields,
  type BonzoProspect,
  type BonzoCommunication,
  type BonzoNote,
} from "@/lib/bonzo/client";

export interface AiAnalysis {
  status_read: string;
  suggested_next_step: string;
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

3. "draft_messages" — 0-2 suggested messages. Each has "channel" (sms or email), "subject" (email only), and "body". Return an empty array if the right move is to send nothing; do not manufacture a touch to fill this field.

4. "suggested_todos" — 0-3 concrete to-dos, each with a "title". Only things the conversation actually calls for.

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
Status: ${prospect.status || "N/A"}
Pipeline Stage: ${prospect.pipeline_stage?.name || "N/A"}`;

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
        const dir = c.direction === "outbound" ? "OUTBOUND" : "INBOUND";
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
  notes: BonzoNote[]
): Promise<AiAnalysis> {
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

  return parsed;
}
