import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getMortgageFields,
  isOptedOut,
  sendSms,
  sendEmail,
  BonzoSendRejectedError,
  BonzoRequestError,
  BonzoRateLimitError,
} from "@/lib/bonzo/client";

describe("getMortgageFields", () => {
  it("reads the `mortgage` key that Bonzo actually returns", () => {
    const prospect = {
      id: 1,
      mortgage: { loan_amount: "450000", credit_score: "720" },
    };
    expect(getMortgageFields(prospect)).toEqual({
      loan_amount: "450000",
      credit_score: "720",
    });
  });

  // Rows cached before the fix hold only {id, name, email, phone}. This is
  // exactly what was in production for every enrolled lead.
  it("returns null for the truncated stub that enrollment used to cache", () => {
    const stub = { id: 5150, name: "Dana Reyes", email: "d@example.com", phone: "555" };
    expect(getMortgageFields(stub)).toBeNull();
  });

  it("still reads a legacy `mortgage_fields` key if one was ever written", () => {
    const legacy = { id: 1, mortgage_fields: { loan_amount: "300000" } };
    expect(getMortgageFields(legacy)).toEqual({ loan_amount: "300000" });
  });

  it("treats an all-null mortgage object as no data", () => {
    const empty = {
      id: 1,
      mortgage: { prospect_id: 1, loan_amount: null, credit_score: null, loan_type: "" },
    };
    expect(getMortgageFields(empty)).toBeNull();
  });

  it("keeps a mortgage object that has even one real value", () => {
    const sparse = { id: 1, mortgage: { prospect_id: 1, loan_purpose: "refinance" } };
    expect(getMortgageFields(sparse)).not.toBeNull();
  });

  it("handles null and undefined without throwing", () => {
    expect(getMortgageFields(null)).toBeNull();
    expect(getMortgageFields(undefined)).toBeNull();
    expect(getMortgageFields({})).toBeNull();
  });
});

describe("isOptedOut", () => {
  it("treats an empty prospect as contactable", () => {
    expect(isOptedOut({ do_not_call: false, opt_outs: [] }, "sms")).toBe(false);
    expect(isOptedOut(null, "sms")).toBe(false);
  });

  it("blocks calls when do_not_call is set", () => {
    const p = { do_not_call: true, opt_outs: [] };
    expect(isOptedOut(p, "call")).toBe(true);
    // do_not_call is specifically about calling; SMS is governed by opt_outs.
    expect(isOptedOut(p, "sms")).toBe(false);
  });

  it("blocks the specific opted-out channel", () => {
    expect(isOptedOut({ opt_outs: ["sms"] }, "sms")).toBe(true);
    expect(isOptedOut({ opt_outs: ["sms"] }, "email")).toBe(false);
    expect(isOptedOut({ opt_outs: ["email"] }, "email")).toBe(true);
  });

  it("blocks every channel when opted out of all", () => {
    const p = { opt_outs: ["all"] };
    expect(isOptedOut(p, "sms")).toBe(true);
    expect(isOptedOut(p, "email")).toBe(true);
    expect(isOptedOut(p, "call")).toBe(true);
  });

  it("matches channel names case-insensitively and by substring", () => {
    expect(isOptedOut({ opt_outs: ["SMS"] }, "sms")).toBe(true);
    expect(isOptedOut({ opt_outs: ["text_message"] }, "sms")).toBe(true);
    expect(isOptedOut({ opt_outs: ["Email Marketing"] }, "email")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

describe("sendSms / sendEmail", () => {
  const origFetch = globalThis.fetch;
  const origToken = process.env.BONZO_API_TOKEN;

  beforeEach(() => {
    process.env.BONZO_API_TOKEN = "test-token";
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    if (origToken === undefined) delete process.env.BONZO_API_TOKEN;
    else process.env.BONZO_API_TOKEN = origToken;
  });

  /** Captures the outgoing request and replies with a canned response. */
  function stubFetch(response: {
    status?: number;
    body?: unknown;
    headers?: Record<string, string>;
  }) {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: (response.status ?? 200) < 400,
        status: response.status ?? 200,
        statusText: "",
        headers: { get: (h: string) => response.headers?.[h.toLowerCase()] ?? null },
        json: async () => response.body,
        text: async () => JSON.stringify(response.body ?? ""),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    return calls;
  }

  const ok = (over: Record<string, unknown> = {}) => ({
    body: {
      data: {
        id: "msg_123",
        status: "sent",
        error_message: "",
        error_blurb: null,
        created_at: "2026-08-20T10:00:00Z",
        ...over,
      },
    },
  });

  it("posts an SMS to the documented endpoint with a message field", async () => {
    const calls = stubFetch(ok());
    const result = await sendSms(4242, "  Numbers are ready.  ");

    expect(calls[0].url).toContain("/v3/prospects/4242/sms");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      message: "Numbers are ready.",
    });
    expect(result.messageId).toBe("msg_123");
  });

  it("posts an email with subject and message as separate fields", async () => {
    // The whole reason email_subject is its own column.
    const calls = stubFetch(ok());
    await sendEmail(4242, "Your refinance numbers", "Hi Dana, they're ready.");

    expect(calls[0].url).toContain("/v3/prospects/4242/email");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      subject: "Your refinance numbers",
      message: "Hi Dana, they're ready.",
    });
  });

  it("omits send_as unless asked, leaving Bonzo's default alone", async () => {
    const calls = stubFetch(ok());
    await sendSms(1, "hi");
    expect(JSON.parse(calls[0].init.body as string).send_as).toBeUndefined();

    const calls2 = stubFetch(ok());
    await sendSms(1, "hi", { sendAs: "me" });
    expect(JSON.parse(calls2[0].init.body as string).send_as).toBe("me");
  });

  it("refuses to send an empty body rather than letting Bonzo 422", async () => {
    stubFetch(ok());
    await expect(sendSms(1, "   ")).rejects.toThrow("empty SMS");
    await expect(sendEmail(1, "subject", "  ")).rejects.toThrow("empty email");
    await expect(sendEmail(1, "  ", "body")).rejects.toThrow("no subject");
  });

  // A 200 is not on its own proof that anything was sent — ApiMessageResource
  // carries its own status and error_message.
  it("throws when Bonzo returns 200 but reports the message failed", async () => {
    stubFetch(ok({ status: "failed", error_message: "Carrier rejected" }));
    await expect(sendSms(1, "hi")).rejects.toThrow(BonzoSendRejectedError);
  });

  it("includes Bonzo's own reason in the rejection", async () => {
    stubFetch(ok({ status: "undelivered", error_message: "Landline" }));
    await expect(sendSms(1, "hi")).rejects.toThrow(/Landline/);
  });

  it("falls back to error_blurb when error_message is empty", async () => {
    stubFetch(ok({ status: "bounced", error_message: "", error_blurb: "Mailbox full" }));
    await expect(sendEmail(1, "s", "b")).rejects.toThrow(/Mailbox full/);
  });

  it("accepts a queued status, which is a normal in-flight state", async () => {
    stubFetch(ok({ status: "queued" }));
    await expect(sendSms(1, "hi")).resolves.toMatchObject({ status: "queued" });
  });

  it("surfaces a 422 with Bonzo's validation detail rather than swallowing it", async () => {
    stubFetch({
      status: 422,
      body: { message: "The given data was invalid.", errors: { message: ["required"] } },
    });
    await expect(sendSms(1, "hi")).rejects.toThrow(BonzoRequestError);
    await expect(sendSms(1, "hi")).rejects.toThrow(/given data was invalid/);
  });

  it("raises a rate-limit error on 429 so the caller can reschedule", async () => {
    stubFetch({ status: 429, headers: { "retry-after": "120" }, body: {} });
    await expect(sendSms(1, "hi")).rejects.toThrow(BonzoRateLimitError);
  });
});
