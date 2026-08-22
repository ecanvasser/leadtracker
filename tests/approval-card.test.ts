import { describe, it, expect } from "vitest";
import {
  renderApprovalCard,
  approvalKeyboard,
  snoozeKeyboard,
  bonzoProspectUrl,
  escapeHtml,
  type ApprovalCardInput,
} from "@/lib/telegram/approval-card";
import { parseCallback, isApprovalCallback, snoozeUntil } from "@/lib/telegram/approval-handlers";
import type { LeadState } from "@/lib/insights/lead-state";

const leadState: LeadState = {
  pitch_response: "price_objection",
  evidence: "That rate is higher than I was expecting",
  evidence_confidence: "high",
  suggested_angle: "He balked at the rate, not the payment — lead with the buydown.",
  last_inbound_at: "2026-07-11T15:00:00Z",
  last_outbound_at: "2026-07-10T17:00:00Z",
  days_since_pitch: 4,
  recommended_action: "hold",
  suppress_until: null,
};

function card(over: Partial<ApprovalCardInput> = {}): ApprovalCardInput {
  return {
    queueItemId: "11111111-1111-1111-1111-111111111111",
    contactName: "Dana Whitfield",
    loanType: "cashout",
    leadAgeDays: 42,
    actionType: "sms",
    draftMessage: "Your collection should have dropped off. Want me to re-pull?",
    emailSubject: null,
    callTalkingPoints: null,
    priorityReason: "Scheduled touch",
    touchLabel: "Touch 2 of 3",
    leadState,
    lastInbound: {
      content: "Sounds good, that's supposed to be this fall.",
      created_at: "2026-07-11T15:00:00Z",
    },
    bonzoProspectId: 4242,
    ...over,
  };
}

describe("renderApprovalCard", () => {
  it("leads with who, what and how old", () => {
    const text = renderApprovalCard(card());
    expect(text).toContain("Dana Whitfield");
    expect(text).toContain("Cash Out");
    expect(text).toContain("day 42");
  });

  it("shows the pitch-response badge and days since the pitch", () => {
    const text = renderApprovalCard(card());
    expect(text).toContain("Price");
    // Section 5: days since pitch is on the card.
    expect(text).toContain("4 days since pitch");
  });

  it("omits days since pitch when the pitch date is unknown", () => {
    // Null must not render as "0 days since pitch", which would read as
    // "just pitched" about a lead that may be weeks cold.
    const text = renderApprovalCard(
      card({ leadState: { ...leadState, days_since_pitch: null } })
    );
    expect(text).not.toContain("since pitch");
  });

  it("marks low-confidence evidence as such", () => {
    const text = renderApprovalCard(
      card({ leadState: { ...leadState, evidence_confidence: "low" } })
    );
    expect(text).toContain("low confidence");
  });

  it("shows the suggested angle rather than the generic priority reason", () => {
    const text = renderApprovalCard(card());
    expect(text).toContain("lead with the buydown");
  });

  // Section 3.2: the card tells Eddie what to raise. It never contains a
  // message for him to send — that whole subsystem is gone.
  it("carries an angle, not a draft", () => {
    const text = renderApprovalCard(card());
    expect(text).not.toMatch(/^Hi |^Hey |^Hello /m);
  });

  it("falls back to the priority reason when there is no lead state", () => {
    const text = renderApprovalCard(card({ leadState: null }));
    expect(text).toContain("Scheduled touch");
  });

  it("shows the evidence quote, so the claim can be checked", () => {
    const text = renderApprovalCard(card());
    expect(text).toContain("That rate is higher than I was expecting");
  });

  it("shows the last inbound message verbatim", () => {
    const text = renderApprovalCard(card());
    expect(text).toContain("Sounds good, that's supposed to be this fall.");
  });

  it("surfaces the touch label, which was previously computed and never shown", () => {
    expect(renderApprovalCard(card())).toContain("Touch 2 of 3");
  });

  it("puts the draft in a pre block so it reads as the literal send text", () => {
    const text = renderApprovalCard(card());
    expect(text).toContain("<pre>");
    expect(text).toContain("Want me to re-pull?");
  });

  it("shows an email subject as its own line", () => {
    const text = renderApprovalCard(
      card({ actionType: "email", emailSubject: "Your credit timeline" })
    );
    expect(text).toContain("Subject: Your credit timeline");
  });

  it("never presents a call as something that will be sent", () => {
    const text = renderApprovalCard(
      card({
        actionType: "call",
        draftMessage: null,
        callTalkingPoints: "• Ask about the collection\n• Offer to re-pull",
      })
    );
    expect(text).toContain("Call");
    expect(text).toContain("Place the call in Bonzo");
    expect(text).not.toContain("SMS draft");
  });

  it("flags a draft that failed validation rather than hiding it", () => {
    const text = renderApprovalCard(
      card({ unvalidatedReasons: ["Contains \"just checking in\""] })
    );
    expect(text).toContain("Unvalidated");
    expect(text).toContain("just checking in");
  });

  it("escapes HTML in prospect content so a stray angle bracket cannot break the card", () => {
    const text = renderApprovalCard(
      card({ lastInbound: { content: "is <b>this</b> a scam?", created_at: "2026-07-11T15:00:00Z" } })
    );
    expect(text).toContain("&lt;b&gt;");
    expect(text).not.toContain("<b>this</b>");
  });

  it("stays inside Telegram's 4096 character limit", () => {
    const text = renderApprovalCard(
      card({ draftMessage: "x".repeat(6000), lastInbound: { content: "y".repeat(3000), created_at: "2026-07-11T15:00:00Z" } })
    );
    expect(text.length).toBeLessThanOrEqual(4096);
  });
});

describe("escapeHtml", () => {
  it("escapes the three characters Telegram's HTML mode cares about", () => {
    expect(escapeHtml('<a & b>')).toBe("&lt;a &amp; b&gt;");
  });
});

describe("approvalKeyboard", () => {
  function codes(kb: ReturnType<typeof approvalKeyboard>): string[] {
    return kb.inline_keyboard
      .flat()
      .map((b) => ("callback_data" in b ? b.callback_data : "url"));
  }

  it("offers send, edit, snooze and skip for a message", () => {
    const kb = approvalKeyboard({
      queueItemId: "abc",
      actionType: "sms",
      bonzoProspectId: 1,
    });
    const all = codes(kb).join(" ");
    expect(all).toContain("qs:abc");
    expect(all).toContain("qe:abc");
    expect(all).toContain("qz:abc");
    expect(all).toContain("qk:abc");
    // Redraft went with the drafting subsystem; its code must not come back
    // by accident. Edit stays — it sends verbatim text and generates nothing.
    expect(all).not.toContain("qr:");
  });

  it("offers only done, snooze and skip for a call", () => {
    const kb = approvalKeyboard({
      queueItemId: "abc",
      actionType: "call",
      bonzoProspectId: 1,
    });
    const all = codes(kb).join(" ");
    expect(all).not.toContain("qe:");
    expect(all).not.toContain("qr:");
    expect(all).toContain("qk:abc");
  });

  it("links out to Bonzo rather than offering to dial", () => {
    const kb = approvalKeyboard({
      queueItemId: "abc",
      actionType: "call",
      bonzoProspectId: 4242,
    });
    const urls = kb.inline_keyboard.flat().filter((b) => "url" in b);
    expect(urls).toHaveLength(1);
    expect((urls[0] as { url: string }).url).toBe(bonzoProspectUrl(4242));
    // Nothing anywhere may be a tel: link.
    expect(JSON.stringify(kb)).not.toContain("tel:");
  });

  it("omits the Bonzo button when there is no linked prospect", () => {
    const kb = approvalKeyboard({
      queueItemId: "abc",
      actionType: "sms",
      bonzoProspectId: null,
    });
    expect(kb.inline_keyboard.flat().filter((b) => "url" in b)).toHaveLength(0);
  });

  // Telegram rejects callback_data over 64 bytes, and ids are 36-char UUIDs.
  it("keeps every callback payload inside Telegram's 64-byte limit", () => {
    const uuid = "11111111-2222-3333-4444-555555555555";
    for (const kb of [
      approvalKeyboard({ queueItemId: uuid, actionType: "sms", bonzoProspectId: 1 }),
      approvalKeyboard({ queueItemId: uuid, actionType: "call", bonzoProspectId: 1 }),
      snoozeKeyboard(uuid),
    ]) {
      for (const btn of kb.inline_keyboard.flat()) {
        if ("callback_data" in btn) {
          expect(Buffer.byteLength(btn.callback_data, "utf8")).toBeLessThanOrEqual(64);
        }
      }
    }
  });
});

describe("snoozeKeyboard", () => {
  it("offers the four documented intervals plus a way back", () => {
    const kb = snoozeKeyboard("abc");
    const all = kb.inline_keyboard.flat().map((b) =>
      "callback_data" in b ? b.callback_data : ""
    );
    expect(all).toContain("qza:abc:2h");
    expect(all).toContain("qza:abc:am");
    expect(all).toContain("qza:abc:3d");
    expect(all).toContain("qza:abc:wk");
    expect(all).toContain("qb:abc");
  });
});

describe("parseCallback", () => {
  it("splits code and id", () => {
    expect(parseCallback("qs:abc")).toEqual({ code: "qs", queueItemId: "abc", arg: undefined });
  });

  it("splits a snooze argument", () => {
    expect(parseCallback("qza:abc:2h")).toEqual({ code: "qza", queueItemId: "abc", arg: "2h" });
  });

  it("returns null for malformed data", () => {
    expect(parseCallback("nonsense")).toBeNull();
  });

  it("recognises only approval codes, leaving contact flows alone", () => {
    expect(isApprovalCallback("qs:abc")).toBe(true);
    expect(isApprovalCallback("lt:purchase")).toBe(false);
    expect(isApprovalCallback("move_contact:abc")).toBe(false);
  });
});

describe("snoozeUntil", () => {
  const tz = "America/Los_Angeles";
  // 2026-08-20 14:00 UTC = 07:00 Pacific.
  const now = new Date("2026-08-20T14:00:00Z");

  it("moves two hours forward for 2h", () => {
    const out = snoozeUntil("2h", now, tz);
    expect(out.getTime() - now.getTime()).toBe(2 * 60 * 60 * 1000);
  });

  it("lands tomorrow morning local for am", () => {
    const out = snoozeUntil("am", now, tz);
    const hour = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
    }).format(out);
    expect(Number(hour)).toBe(9);
    expect(out.getTime()).toBeGreaterThan(now.getTime());
  });

  it("lands three days out at 9am local", () => {
    const out = snoozeUntil("3d", now, tz);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(out);
    expect(parts).toBe("2026-08-23");
  });

  it("lands a week out", () => {
    const out = snoozeUntil("wk", now, tz);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(out);
    expect(parts).toBe("2026-08-27");
  });

  it("still lands at 9am local across a DST boundary", () => {
    // Pacific falls back on 2026-11-01.
    const beforeDst = new Date("2026-10-30T14:00:00Z");
    const out = snoozeUntil("3d", beforeDst, tz);
    const hour = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
    }).format(out);
    expect(Number(hour)).toBe(9);
  });
});
