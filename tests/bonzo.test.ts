import { describe, it, expect } from "vitest";
import { getMortgageFields, isOptedOut } from "@/lib/bonzo/client";

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
