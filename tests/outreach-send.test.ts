import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { describeSendFailure } from "@/lib/outreach/send";
import {
  BonzoRateLimitError,
  BonzoRequestError,
  BonzoSendRejectedError,
} from "@/lib/bonzo/client";

describe("describeSendFailure", () => {
  it("tells the broker nothing was sent on a rate limit, with the wait", () => {
    const msg = describeSendFailure(new BonzoRateLimitError(120_000));
    expect(msg).toContain("Nothing was sent");
    expect(msg).toContain("120s");
  });

  it("explains a 200-with-failed-status rather than reporting success", () => {
    const msg = describeSendFailure(
      new BonzoSendRejectedError("undelivered", "msg_1", "Landline")
    );
    expect(msg).toContain("undelivered");
    expect(msg).toContain("Landline");
  });

  it("surfaces Bonzo's own validation detail on a 422", () => {
    const err = new BonzoRequestError(
      422,
      "Unprocessable",
      JSON.stringify({
        message: "The given data was invalid.",
        errors: { subject: ["The subject field is required."] },
      })
    );
    const msg = describeSendFailure(err);
    expect(msg).toContain("subject");
    expect(msg).toContain("required");
  });

  it("falls back to the raw body when a 422 is not JSON", () => {
    const err = new BonzoRequestError(422, "Unprocessable", "upstream exploded");
    expect(describeSendFailure(err)).toContain("upstream exploded");
  });

  it("explains a 404 in terms of the prospect", () => {
    const msg = describeSendFailure(new BonzoRequestError(404, "Not Found", ""));
    expect(msg).toContain("could not find that prospect");
  });

  it("still says nothing was sent for an unmapped status", () => {
    const msg = describeSendFailure(new BonzoRequestError(500, "Server Error", ""));
    expect(msg).toContain("Nothing was sent");
  });

  it("handles a non-Error throw without crashing the receipt", () => {
    expect(describeSendFailure("boom")).toContain("unknown reason");
  });
});

// ---------------------------------------------------------------------------
// sendQueueItem
//
// Mocked at the Bonzo client boundary so these assert orchestration: what gets
// sent, in what order state changes, and what happens on a retry.
// ---------------------------------------------------------------------------

const bonzo = vi.hoisted(() => ({
  sendSms: vi.fn(),
  sendEmail: vi.fn(),
  getProspect: vi.fn(),
}));

vi.mock("@/lib/bonzo/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/bonzo/client")>();
  return { ...actual, ...bonzo };
});

const { sendQueueItem, SendRefusedError } = await import("@/lib/outreach/send");

interface Row {
  id: string;
  user_id: string;
  contact_id: string;
  action_type: string;
  draft_message: string | null;
  email_subject: string | null;
  status: string;
}

function stub(opts: {
  item?: Partial<Row>;
  contact?: { bonzo_prospect_id: number | null; name: string } | null;
  lastLog?: Record<string, unknown> | null;
}) {
  const item: Row = {
    id: "q1",
    user_id: "u1",
    contact_id: "c1",
    action_type: "sms",
    draft_message: "Numbers are ready.",
    email_subject: null,
    status: "pending",
    ...opts.item,
  };
  const contact =
    opts.contact === undefined
      ? { bonzo_prospect_id: 4242, name: "Dana" }
      : opts.contact;

  const queueUpdates: Record<string, unknown>[] = [];
  const logInserts: Record<string, unknown>[] = [];

  const client = {
    from(table: string) {
      if (table === "daily_queue") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: item, error: null }) }),
            }),
          }),
          update(payload: Record<string, unknown>) {
            queueUpdates.push(payload);
            return { eq: async () => ({ error: null }) };
          },
        };
      }
      if (table === "contacts") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: contact, error: null }) }),
          }),
        };
      }
      // outreach_log
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: opts.lastLog ?? null, error: null }),
                }),
              }),
            }),
          }),
        }),
        insert: async (payload: Record<string, unknown>) => {
          logInserts.push(payload);
          return { error: null };
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { client, queueUpdates, logInserts };
}

const sent = { messageId: "msg_9", status: "sent", errorMessage: null, createdAt: null };

describe("sendQueueItem", () => {
  beforeEach(() => {
    bonzo.sendSms.mockReset().mockResolvedValue(sent);
    bonzo.sendEmail.mockReset().mockResolvedValue(sent);
    bonzo.getProspect.mockReset().mockResolvedValue({ do_not_call: false, opt_outs: [] });
  });

  afterEach(() => vi.clearAllMocks());

  it("sends an SMS and records the provider message id", async () => {
    const { client, queueUpdates, logInserts } = stub({});
    const out = await sendQueueItem(client, "u1", "q1");

    expect(bonzo.sendSms).toHaveBeenCalledWith(4242, "Numbers are ready.");
    expect(out.status).toBe("sent");
    expect(queueUpdates[0].status).toBe("sent");
    expect(logInserts[0].provider_message_id).toBe("msg_9");
  });

  it("sends an email with subject and body as separate fields", async () => {
    const { client } = stub({
      item: {
        action_type: "email",
        email_subject: "Your numbers",
        draft_message: "They're ready.",
      },
    });
    await sendQueueItem(client, "u1", "q1");
    expect(bonzo.sendEmail).toHaveBeenCalledWith(4242, "Your numbers", "They're ready.");
  });

  // Telegram retries webhooks; a duplicate callback must not double-send.
  it("does not send again for an item already marked sent", async () => {
    const { client } = stub({
      item: { status: "sent" },
      lastLog: { provider_message_id: "msg_1", draft_message: "x", email_subject: null },
    });
    const out = await sendQueueItem(client, "u1", "q1");

    expect(bonzo.sendSms).not.toHaveBeenCalled();
    expect(out.status).toBe("already_sent");
    expect(out.receipt).toContain("no duplicate");
  });

  it("treats an edited_sent item as already sent too", async () => {
    const { client } = stub({ item: { status: "edited_sent" } });
    const out = await sendQueueItem(client, "u1", "q1");
    expect(bonzo.sendSms).not.toHaveBeenCalled();
    expect(out.status).toBe("already_sent");
  });

  it("uses the edited body and marks the item edited_sent", async () => {
    const { client, queueUpdates } = stub({});
    await sendQueueItem(client, "u1", "q1", { overrideBody: "Shorter version." });

    expect(bonzo.sendSms).toHaveBeenCalledWith(4242, "Shorter version.");
    expect(queueUpdates[0].status).toBe("edited_sent");
    // The edit becomes the row's message, not just a log entry.
    expect(queueUpdates[0].draft_message).toBe("Shorter version.");
  });

  // Opt-out is a compliance matter, so it is checked live rather than from a
  // cache that can be fifteen minutes stale.
  it("refuses to send to a prospect who opted out, and skips the item", async () => {
    bonzo.getProspect.mockResolvedValue({ do_not_call: false, opt_outs: ["sms"] });
    const { client, queueUpdates } = stub({});

    await expect(sendQueueItem(client, "u1", "q1")).rejects.toThrow(SendRefusedError);
    expect(bonzo.sendSms).not.toHaveBeenCalled();
    expect(queueUpdates[0].status).toBe("skipped");
  });

  it("still sends when the opt-out is for a different channel", async () => {
    bonzo.getProspect.mockResolvedValue({ do_not_call: false, opt_outs: ["email"] });
    const { client } = stub({});
    await expect(sendQueueItem(client, "u1", "q1")).resolves.toMatchObject({ status: "sent" });
  });

  // The ordering rule: nothing is marked sent unless Bonzo confirmed it.
  it("leaves the item pending when Bonzo fails", async () => {
    bonzo.sendSms.mockRejectedValue(new BonzoRequestError(500, "Server Error", ""));
    const { client, queueUpdates, logInserts } = stub({});

    await expect(sendQueueItem(client, "u1", "q1")).rejects.toThrow(SendRefusedError);
    expect(queueUpdates).toEqual([]);
    expect(logInserts).toEqual([]);
  });

  it("leaves the item pending when Bonzo reports the message failed", async () => {
    bonzo.sendSms.mockRejectedValue(
      new BonzoSendRejectedError("failed", "msg_2", "Carrier rejected")
    );
    const { client, queueUpdates } = stub({});
    await expect(sendQueueItem(client, "u1", "q1")).rejects.toThrow(/Carrier rejected/);
    expect(queueUpdates).toEqual([]);
  });

  it("refuses a call item rather than trying to message it", async () => {
    const { client } = stub({ item: { action_type: "call", draft_message: null } });
    await expect(sendQueueItem(client, "u1", "q1")).rejects.toThrow(/Calls are placed in Bonzo/);
  });

  it("refuses an email with no subject, since Bonzo requires one", async () => {
    const { client } = stub({
      item: { action_type: "email", email_subject: null, draft_message: "body" },
    });
    await expect(sendQueueItem(client, "u1", "q1")).rejects.toThrow(/no subject/);
    expect(bonzo.sendEmail).not.toHaveBeenCalled();
  });

  it("refuses an empty body", async () => {
    const { client } = stub({ item: { draft_message: "   " } });
    await expect(sendQueueItem(client, "u1", "q1")).rejects.toThrow(/no message text/);
  });

  it("refuses when the contact has no linked Bonzo prospect", async () => {
    const { client } = stub({ contact: { bonzo_prospect_id: null, name: "Dana" } });
    await expect(sendQueueItem(client, "u1", "q1")).rejects.toThrow(/not linked/);
  });

  it("sends anyway when the live opt-out check itself fails", async () => {
    // A Bonzo outage on the check should not block every send; the send call
    // would fail on its own if Bonzo is genuinely down.
    bonzo.getProspect.mockRejectedValue(new Error("timeout"));
    const { client } = stub({});
    await expect(sendQueueItem(client, "u1", "q1")).resolves.toMatchObject({ status: "sent" });
  });
});
