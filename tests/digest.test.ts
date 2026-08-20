import { describe, it, expect } from "vitest";
import { renderDigest, digestKeyboard, type DigestItem } from "@/lib/telegram/digest";
import { enqueueDigestIfDue } from "@/lib/jobs/enqueue";

function item(over: Partial<DigestItem> = {}): DigestItem {
  return {
    contactName: "Dana Whitfield",
    loanType: "cashout",
    actionType: "sms",
    whyNow: "Collection was due to drop this fall; it has.",
    leadTemp: "warming",
    ...over,
  };
}

describe("renderDigest", () => {
  it("leads with the count", () => {
    const text = renderDigest([item(), item({ contactName: "Ray" })], 2);
    expect(text).toContain("2 leads queued today");
  });

  it("uses the singular for one lead", () => {
    expect(renderDigest([item()], 1)).toContain("1 lead queued today");
  });

  it("shows at most three, then says how many remain", () => {
    const items = Array.from({ length: 9 }, (_, i) => item({ contactName: `Lead ${i}` }));
    const text = renderDigest(items, 9);

    expect(text).toContain("Lead 0");
    expect(text).toContain("Lead 2");
    expect(text).not.toContain("Lead 3");
    expect(text).toContain("and 6 more");
  });

  it("does not say 'and more' when everything is shown", () => {
    expect(renderDigest([item()], 1)).not.toContain("more");
  });

  it("includes why_now for each shown lead", () => {
    expect(renderDigest([item()], 1)).toContain("Collection was due to drop");
  });

  it("names the channel in plain language", () => {
    expect(renderDigest([item({ actionType: "sms" })], 1)).toContain("text");
    expect(renderDigest([item({ actionType: "call" })], 1)).toContain("call");
    expect(renderDigest([item({ actionType: "email" })], 1)).toContain("email");
  });

  // An empty queue is a real answer from the engine, not a failure to produce
  // work, and the digest should say so rather than looking broken.
  it("frames an empty day as a decision, not a gap", () => {
    const text = renderDigest([], 0);
    expect(text).toContain("Nothing queued today");
    expect(text).toContain("holds rather than manufacturing");
  });

  it("escapes HTML in a prospect name", () => {
    const text = renderDigest([item({ contactName: "A <b>B</b>" })], 1);
    expect(text).toContain("&lt;b&gt;");
  });

  it("truncates a very long why_now rather than flooding the digest", () => {
    const text = renderDigest([item({ whyNow: "x".repeat(500) })], 1);
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(500);
  });
});

describe("digestKeyboard", () => {
  it("offers Start when there is something to do", () => {
    const kb = digestKeyboard(true);
    expect(kb).toBeDefined();
    expect(JSON.stringify(kb)).toContain("dgstart");
  });

  it("offers no button on an empty day", () => {
    expect(digestKeyboard(false)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

function stub(settings: Record<string, unknown> | null) {
  const inserts: Record<string, unknown>[] = [];
  const client = {
    from(table: string) {
      if (table === "user_settings") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: settings, error: null }) }),
          }),
        };
      }
      return {
        insert: async (payload: Record<string, unknown>) => {
          inserts.push(payload);
          return { error: null };
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { client, inserts };
}

const base = {
  timezone: "America/Los_Angeles",
  morning_digest_time: "08:00",
  last_digest_date: null,
};

describe("enqueueDigestIfDue", () => {
  // 16:00 UTC = 09:00 Pacific — past an 08:00 digest time.
  const AFTER = new Date("2026-08-20T16:00:00Z");
  // 13:00 UTC = 06:00 Pacific — before it.
  const BEFORE = new Date("2026-08-20T13:00:00Z");

  it("enqueues once the local clock passes the digest time", async () => {
    const { client, inserts } = stub(base);
    const out = await enqueueDigestIfDue(client, "u1", AFTER);

    expect(out.enqueued).toBe(true);
    expect(inserts[0].job_type).toBe("morning_digest");
  });

  it("does not enqueue before the digest time", async () => {
    const { client, inserts } = stub(base);
    const out = await enqueueDigestIfDue(client, "u1", BEFORE);

    expect(out.enqueued).toBe(false);
    expect(out.reason).toContain("before digest time");
    expect(inserts).toEqual([]);
  });

  it("does not enqueue twice on the same local day", async () => {
    const { client, inserts } = stub({ ...base, last_digest_date: "2026-08-20" });
    const out = await enqueueDigestIfDue(client, "u1", AFTER);

    expect(out.enqueued).toBe(false);
    expect(out.reason).toContain("already sent today");
    expect(inserts).toEqual([]);
  });

  it("enqueues again the next local day", async () => {
    const { client, inserts } = stub({ ...base, last_digest_date: "2026-08-19" });
    expect((await enqueueDigestIfDue(client, "u1", AFTER)).enqueued).toBe(true);
    expect(inserts).toHaveLength(1);
  });

  // The digest time is a local-clock concept; UTC would drift by an hour
  // across DST and be simply wrong for another zone.
  it("evaluates the digest time in the user's timezone", async () => {
    // 16:00 UTC is 12:00 in New York — past 08:00 there too.
    const ny = stub({ ...base, timezone: "America/New_York" });
    expect((await enqueueDigestIfDue(ny.client, "u1", AFTER)).enqueued).toBe(true);

    // 16:00 UTC is 01:00 next day in Tokyo — before 08:00.
    const tokyo = stub({ ...base, timezone: "Asia/Tokyo" });
    expect((await enqueueDigestIfDue(tokyo.client, "u1", AFTER)).enqueued).toBe(false);
  });

  it("respects a custom digest time", async () => {
    const late = stub({ ...base, morning_digest_time: "10:00" });
    // 09:00 Pacific is before a 10:00 digest.
    expect((await enqueueDigestIfDue(late.client, "u1", AFTER)).enqueued).toBe(false);
  });

  // Better a late digest than none — a worker that was down all morning
  // should still deliver when it comes back.
  it("still enqueues long after the digest time has passed", async () => {
    const evening = new Date("2026-08-21T02:00:00Z"); // 19:00 Pacific
    const { client } = stub(base);
    expect((await enqueueDigestIfDue(client, "u1", evening)).enqueued).toBe(true);
  });

  it("does nothing when the user has no settings row", async () => {
    const { client, inserts } = stub(null);
    expect((await enqueueDigestIfDue(client, "u1", AFTER)).enqueued).toBe(false);
    expect(inserts).toEqual([]);
  });
});
