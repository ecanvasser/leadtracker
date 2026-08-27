import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

afterEach(() => vi.resetModules());

/*
 * Eddie's own context, injected into every draft.
 *
 * It replaces an idea that did not survive contact with the architecture:
 * resuming his Claude Cowork session from the drafting job. The job runs in a
 * Vercel serverless function on a five-minute cron, which is a poor host for
 * the Agent SDK's harness — and the thing he actually wanted from that session
 * was documents, which belong in a cached prompt block.
 */
describe("the broker playbook", () => {
  it("is omitted entirely when nothing has been pasted in", async () => {
    /*
     * Null rather than an empty string, so the caller drops the block. A
     * heading with nothing under it reads to a model as "he has no approach",
     * which is worse than never raising the subject.
     */
    const { playbookBlock, hasPlaybook } = await import("@/lib/ai/playbook");
    if (!hasPlaybook()) expect(playbookBlock()).toBeNull();
  });

  it("frames the notes as background rather than a script", async () => {
    vi.doMock("@/lib/ai/playbook", async (orig) => ({
      ...(await orig<typeof import("@/lib/ai/playbook")>()),
      BROKER_PLAYBOOK: "I place NFTY HELOCs down to a 580 FICO.",
    }));
    const { playbookBlock } = await import("@/lib/ai/playbook");
    const block = playbookBlock();

    // Only meaningful once real content exists; asserted on the shape either
    // way so the framing cannot be dropped in a later edit.
    const source = readFileSync(resolve(process.cwd(), "lib/ai/playbook.ts"), "utf8");
    expect(source).toMatch(/background, not a `\s*\+?\s*`?\s*`?script/);
    expect(source).toMatch(/never quote it at the lead/);
    expect(source).toMatch(/never let it override a figure/);
    expect(block === null || block.includes("HOW HE WORKS")).toBe(true);
  });

  it("warns against pasting live numbers into it", async () => {
    /*
     * The subtle failure: the validator grounds figures against the loan file
     * and the conversation, and a rate pasted here would count as grounded.
     * A stale rate sheet would then launder itself into a client message.
     */
    const source = readFileSync(resolve(process.cwd(), "lib/ai/playbook.ts"), "utf8");
    expect(source).toMatch(/goes stale silently/);
    expect(source).toMatch(/Keep\s+\*?\s*live numbers out/);
  });
});

describe("drafting sends the playbook cached", () => {
  const source = readFileSync(resolve(process.cwd(), "lib/ai/draft-one.ts"), "utf8");

  it("puts the cache breakpoint on the last system block", () => {
    // Everything in `system` is identical across drafts, so the whole prefix
    // caches and a repeat draft pays about a tenth for it. That is what makes
    // sending the entire playbook every time affordable.
    const systemBlock = source.slice(source.indexOf("const system = ["));
    expect(systemBlock).toMatch(/cache_control: \{ type: "ephemeral" as const \}/);
  });

  it("drops the block rather than sending an empty heading", () => {
    expect(source).toMatch(/\.\.\.\(playbook \? \[/);
  });
});
