import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getMortgageFields,
  isOptedOut,
  isInbound,
  isOutbound,
  mapBonzoLoanType,
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

// Bonzo returns "incoming"/"outgoing". The codebase was written against
// "inbound"/"outbound", which Bonzo has never sent — so every direction check
// silently matched nothing against real data.
describe("isInbound / isOutbound", () => {
  it("recognises the words Bonzo actually sends", () => {
    expect(isInbound("incoming")).toBe(true);
    expect(isOutbound("outgoing")).toBe(true);
  });

  it("still recognises the inbound/outbound vocabulary", () => {
    // insights_cache holds historical payloads that may use either.
    expect(isInbound("inbound")).toBe(true);
    expect(isOutbound("outbound")).toBe(true);
  });

  it("is case and whitespace insensitive", () => {
    expect(isInbound("  INCOMING ")).toBe(true);
    expect(isOutbound("Outgoing")).toBe(true);
  });

  it("keeps the two directions mutually exclusive", () => {
    expect(isOutbound("incoming")).toBe(false);
    expect(isInbound("outgoing")).toBe(false);
  });

  it("treats an unknown direction as neither", () => {
    // Guessing would put a prospect's words into the broker's voice profile.
    expect(isInbound("sideways")).toBe(false);
    expect(isOutbound("sideways")).toBe(false);
  });

  it("handles null and undefined", () => {
    expect(isInbound(null)).toBe(false);
    expect(isOutbound(undefined)).toBe(false);
    expect(isInbound("")).toBe(false);
  });
});

/**
 * Bonzo import hardcoded loan_type: "purchase" for every lead, so a cash-out
 * refinance arrived labelled a purchase and every draft written for it
 * reasoned from the wrong product.
 */
describe("mapBonzoLoanType", () => {
  const cases: [string, string | null, string | null][] = [
    // [expected, loan_type, loan_purpose]
    ["purchase", "Purchase", null],
    ["purchase", "purchase", "Home Purchase"],
    ["cashout", "Refinance", "Cash Out"],
    ["cashout", "Cash-Out Refinance", null],
    ["cashout", "cashout", null],
    ["rate_term", "Refinance", "Rate and Term"],
    ["rate_term", "Rate & Term Refinance", null],
    ["rate_term", "Refinance", null],
    ["heloc", "HELOC", null],
    ["heloc", "Home Equity Line of Credit", null],
    ["heloan", "Home Equity Loan", null],
    ["hei", "HEI", null],
    ["hei", "Shared Equity Investment", null],
    ["hard_money", "Hard Money", null],
    ["hard_money", "Bridge Loan", null],
    ["fast_50", "Fast 50", null],
    ["reverse", "Reverse Mortgage", null],
    ["reverse", "HECM", null],
    ["reverse", "Home Equity Conversion Mortgage", null],
    ["reverse", "Reverse", "Purchase"],
  ];

  for (const [expected, loan_type, loan_purpose] of cases) {
    it(`maps ${JSON.stringify(loan_type)} / ${JSON.stringify(loan_purpose)} to ${expected}`, () => {
      expect(mapBonzoLoanType({ loan_type, loan_purpose })).toBe(expected);
    });
  }

  // A HECM-to-HECM refinance is still a reverse mortgage. The bare-refinance
  // rule sits at the bottom of the array and would claim this record if the
  // reverse rule were not above it — the exact ordering bug the array's comment
  // warns about, and the reason the new rule went in at the top.
  it("prefers reverse over the bare refinance match", () => {
    expect(mapBonzoLoanType({ loan_type: "Reverse Mortgage Refinance", loan_purpose: null }))
      .toBe("reverse");
    expect(mapBonzoLoanType({ loan_type: "Refinance", loan_purpose: "HECM to HECM" }))
      .toBe("reverse");
  });

  // Reverse must not swallow the other home-equity products, whose rules sit
  // below it now.
  it("leaves the other equity products alone", () => {
    expect(mapBonzoLoanType({ loan_type: "Home Equity Line of Credit", loan_purpose: null }))
      .toBe("heloc");
    expect(mapBonzoLoanType({ loan_type: "Home Equity Loan", loan_purpose: null }))
      .toBe("heloan");
  });

  // "cash out refinance" contains "refinance"; the specific reading must win.
  it("prefers cash-out over the bare refinance match", () => {
    expect(mapBonzoLoanType({ loan_type: "Cash Out Refinance", loan_purpose: null }))
      .toBe("cashout");
  });

  it("reads the distinction from loan_purpose when loan_type is generic", () => {
    expect(mapBonzoLoanType({ loan_type: "Refinance", loan_purpose: "Cash-Out" }))
      .toBe("cashout");
    expect(mapBonzoLoanType({ loan_type: "Refinance", loan_purpose: "No Cash Out" }))
      .toBe("rate_term");
  });

  it("is tolerant of punctuation and casing", () => {
    expect(mapBonzoLoanType({ loan_type: "  CASH-OUT  ", loan_purpose: null })).toBe("cashout");
    expect(mapBonzoLoanType({ loan_type: "H.E.L.O.C.", loan_purpose: null })).toBe("heloc");
  });

  // Returning null rather than guessing is the point: silently defaulting is
  // what produced the original bug.
  it("returns null rather than guessing", () => {
    // Was "Reverse Mortgage" until phase 6 added it as a real product. The
    // assertion still needs a loan type the mapper genuinely does not know.
    expect(mapBonzoLoanType({ loan_type: "Construction Loan", loan_purpose: null })).toBeNull();
    expect(mapBonzoLoanType({ loan_type: null, loan_purpose: null })).toBeNull();
    expect(mapBonzoLoanType({ loan_type: "", loan_purpose: "" })).toBeNull();
    expect(mapBonzoLoanType(null)).toBeNull();
    expect(mapBonzoLoanType(undefined)).toBeNull();
  });
});
