import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { modelFor, supportsSampling } from "@/lib/ai/models";

const ENV_KEYS = [
  "ANTHROPIC_MODEL_ANALYSIS",
  "ANTHROPIC_MODEL_DRAFT",
  "ANTHROPIC_MODEL_EXTRACT",
];

describe("modelFor", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("routes each role to its documented default", () => {
    expect(modelFor("analysis")).toBe("claude-opus-5");
    expect(modelFor("draft")).toBe("claude-sonnet-5");
    expect(modelFor("extract")).toBe("claude-haiku-4-5");
  });

  it("lets an env var override each role independently", () => {
    process.env.ANTHROPIC_MODEL_DRAFT = "claude-opus-4-8";
    expect(modelFor("draft")).toBe("claude-opus-4-8");
    // Others are unaffected.
    expect(modelFor("analysis")).toBe("claude-opus-5");
  });

  it("ignores an empty or whitespace-only env var", () => {
    process.env.ANTHROPIC_MODEL_DRAFT = "   ";
    expect(modelFor("draft")).toBe("claude-sonnet-5");
  });

  it("routes analysis to a more capable model than drafting by default", () => {
    // The cost plan depends on this split: judgment-heavy low-volume work on
    // the expensive model, high-volume drafting on the mid tier.
    expect(modelFor("analysis")).not.toBe(modelFor("draft"));
    expect(modelFor("draft")).not.toBe(modelFor("extract"));
  });
});

// The spec asked for temperature: 0.3 on drafting calls. Sampling was removed
// on the current model generation — sending it returns a 400 and the whole
// drafting path fails. These assertions pin that knowledge in place so nobody
// reintroduces it by pinning a model and adding the parameter back.
describe("supportsSampling", () => {
  it("is false for the models that reject sampling parameters", () => {
    expect(supportsSampling("claude-sonnet-5")).toBe(false);
    expect(supportsSampling("claude-opus-5")).toBe(false);
    expect(supportsSampling("claude-opus-4-8")).toBe(false);
    expect(supportsSampling("claude-opus-4-7")).toBe(false);
    expect(supportsSampling("claude-fable-5")).toBe(false);
  });

  it("is true for older models that still accept temperature", () => {
    expect(supportsSampling("claude-sonnet-4-6")).toBe(true);
    expect(supportsSampling("claude-opus-4-6")).toBe(true);
    expect(supportsSampling("claude-haiku-4-5")).toBe(true);
  });

  it("is false for the default draft model, so no temperature is sent", () => {
    expect(supportsSampling(modelFor("draft"))).toBe(false);
  });
});
