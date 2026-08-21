import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ALL_STAGES,
  PIPELINE_STAGES,
  QUEUE_ELIGIBLE_STAGES,
  STAGE_LABELS,
  LOAN_TYPES,
  LOAN_TYPE_LABELS,
  DEFAULT_STAGE,
  isQueueEligible,
} from "@/types/db";
import { createContact, findExistingBonzoContact } from "@/lib/db/contacts";

describe("stage and loan-type tables", () => {
  it("labels every stage and every loan type", () => {
    for (const s of ALL_STAGES) expect(STAGE_LABELS[s]).toBeTruthy();
    for (const lt of LOAN_TYPES) expect(LOAN_TYPE_LABELS[lt]).toBeTruthy();
  });

  it("keeps Needs Quote in the pipeline, between Hot Leads and App In", () => {
    expect(PIPELINE_STAGES.indexOf("needs_quote")).toBe(
      PIPELINE_STAGES.indexOf("hot_lead") + 1
    );
    expect(PIPELINE_STAGES.indexOf("needs_quote")).toBeLessThan(
      PIPELINE_STAGES.indexOf("app_in")
    );
  });

  it("keeps adverse a real stage even though its column is gone", () => {
    expect(ALL_STAGES).toContain("adverse");
    expect(PIPELINE_STAGES).not.toContain("adverse");
  });

  it("carries HELOAN and Reverse", () => {
    expect(LOAN_TYPE_LABELS.heloan).toBe("HELOAN");
    expect(LOAN_TYPES).toContain("reverse");
    expect(LOAN_TYPE_LABELS.reverse).toBe("Reverse");
  });
});

describe("QUEUE_ELIGIBLE_STAGES", () => {
  it("only names real stages", () => {
    for (const s of QUEUE_ELIGIBLE_STAGES) expect(ALL_STAGES).toContain(s);
  });

  it("is what the default stage is", () => {
    expect(isQueueEligible(DEFAULT_STAGE)).toBe(true);
  });

  // D1: needs_quote is deliberately out. If this flips, it must flip on
  // purpose — every automation path reads the same constant.
  it("accepts exactly the stages it names and rejects every other one", () => {
    for (const s of ALL_STAGES) {
      expect(isQueueEligible(s)).toBe(
        (QUEUE_ELIGIBLE_STAGES as readonly string[]).includes(s)
      );
    }
    expect(isQueueEligible("needs_quote")).toBe(false);
    expect(isQueueEligible("adverse")).toBe(false);
    expect(isQueueEligible(null)).toBe(false);
    expect(isQueueEligible(undefined)).toBe(false);
    expect(isQueueEligible("not_a_stage")).toBe(false);
  });
});

/**
 * The structural half of the D1 guard.
 *
 * The behavioural tests above only prove the constant is right. This proves
 * every automation path actually *reads* it: before phase 6 the same decision
 * was written out eight times, so adding a stage removed those leads from the
 * queue silently. A bare 'hot_lead' literal reappearing in any of these files
 * is that bug coming back.
 */
describe("no hardcoded stage literals in the automation paths", () => {
  const files = [
    "app/api/daily-queue/generate/route.ts",
    "lib/jobs/enqueue.ts",
    "lib/jobs/handlers.ts",
    "lib/db/contacts.ts",
    "components/board/board.tsx",
    "components/board/contact-card.tsx",
    "components/contact/contact-dialog.tsx",
    "app/(app)/contacts/[contactId]/insights-panel.tsx",
  ];

  for (const file of files) {
    it(`${file} reads the shared constant`, () => {
      const src = readFileSync(resolve(process.cwd(), file), "utf8")
        // Comments may name the stage while explaining the history.
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(src).not.toContain('"hot_lead"');
      expect(src).not.toContain("'hot_lead'");
    });
  }
});

/** Records what createContact asked the database for. */
function createStub(existingMax: number | null) {
  const queries: { stage?: string } = {};
  let inserted: Record<string, unknown> = {};
  const client = {
    from() {
      return {
        select: () => ({
          eq: (_col: string, value: string) => {
            queries.stage = value;
            return {
              order: () => ({
                limit: () => ({
                  single: async () => ({
                    data: existingMax === null ? null : { position: existingMax },
                  }),
                }),
              }),
            };
          },
        }),
        insert(payload: Record<string, unknown>) {
          inserted = payload;
          return {
            select: () => ({
              single: async () => ({ data: { id: "new", ...payload }, error: null }),
            }),
          };
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { client, queries, get inserted() { return inserted; } };
}

describe("createContact", () => {
  // 5.3 — a contact created into App In must be positioned at the bottom of
  // App In, not given a position borrowed from Hot Leads.
  it("computes position inside the target stage", async () => {
    const s = createStub(7000);
    await createContact(s.client, {
      user_id: "u1",
      name: "Dana",
      loan_type: "reverse",
      crm: "bonzo",
      stage: "app_in",
    });

    expect(s.queries.stage).toBe("app_in");
    expect(s.inserted.stage).toBe("app_in");
    expect(s.inserted.position).toBe(8000);
  });

  it("positions into Needs Quote when that is the target", async () => {
    const s = createStub(null);
    await createContact(s.client, {
      user_id: "u1",
      name: "Sam",
      loan_type: "purchase",
      crm: "bonzo",
      stage: "needs_quote",
    });

    expect(s.queries.stage).toBe("needs_quote");
    expect(s.inserted.position).toBe(1000);
  });

  it("falls back to the default stage when none is given", async () => {
    const s = createStub(null);
    await createContact(s.client, {
      user_id: "u1",
      name: "Alex",
      loan_type: "heloan",
      crm: "bonzo",
    });

    expect(s.queries.stage).toBe(DEFAULT_STAGE);
    expect(s.inserted.stage).toBe(DEFAULT_STAGE);
  });
});

/**
 * Stub for the duplicate lookup. `byProspectId` and `byEmail` stand for the two
 * round-trips; `filters` records which columns were actually queried.
 */
function lookupStub(rows: {
  byProspectId?: { id: string; name: string; stage: string } | null;
  byEmail?: { id: string; name: string; stage: string } | null;
}) {
  const filters: string[] = [];
  const client = {
    from() {
      return {
        select: () => ({
          eq: (col: string) => {
            filters.push(col);
            return {
              limit: () => ({
                maybeSingle: async () => ({ data: rows.byProspectId ?? null }),
              }),
            };
          },
          ilike: (col: string) => {
            filters.push(col);
            return {
              limit: () => ({
                maybeSingle: async () => ({ data: rows.byEmail ?? null }),
              }),
            };
          },
        }),
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { client, filters };
}

describe("findExistingBonzoContact", () => {
  // 5.2 — the old check was scoped to hot_lead, so the same prospect could be
  // imported twice into two different columns with no warning at all.
  it("finds a duplicate sitting in a non-hot stage", async () => {
    const s = lookupStub({
      byProspectId: { id: "c1", name: "Dana Reyes", stage: "processing" },
    });
    const found = await findExistingBonzoContact(s.client, {
      prospectId: 5150,
      email: "d@example.com",
    });

    expect(found?.stage).toBe("processing");
    // Matched on the prospect id; no need for the email fallback.
    expect(s.filters).toEqual(["bonzo_prospect_id"]);
  });

  it("finds a duplicate in adverse", async () => {
    const s = lookupStub({
      byProspectId: { id: "c9", name: "Sam Lee", stage: "adverse" },
    });
    const found = await findExistingBonzoContact(s.client, { prospectId: 42 });
    expect(found?.stage).toBe("adverse");
  });

  // Rows written before bonzo_prospect_id was stored carry only the email.
  it("falls back to the email when the prospect id does not match", async () => {
    const s = lookupStub({
      byProspectId: null,
      byEmail: { id: "c2", name: "Old Row", stage: "hot_lead" },
    });
    const found = await findExistingBonzoContact(s.client, {
      prospectId: 5150,
      email: "d@example.com",
    });

    expect(found?.id).toBe("c2");
    expect(s.filters).toEqual(["bonzo_prospect_id", "bonzo_email"]);
  });

  it("returns null when the prospect is genuinely new", async () => {
    const s = lookupStub({ byProspectId: null, byEmail: null });
    expect(
      await findExistingBonzoContact(s.client, { prospectId: 1, email: "new@example.com" })
    ).toBeNull();
  });

  it("skips the email query when there is no email to match", async () => {
    const s = lookupStub({ byProspectId: null });
    await findExistingBonzoContact(s.client, { prospectId: 1, email: "   " });
    expect(s.filters).toEqual(["bonzo_prospect_id"]);
  });
});
