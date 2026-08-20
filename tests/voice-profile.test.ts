import { describe, it, expect } from "vitest";
import { normalizeProfile, exemplarsFor } from "@/lib/ai/voice-profile";
import { renderVoiceProfile, renderStyleExemplars } from "@/lib/ai/prompts";
import { validateProfileShape } from "@/app/api/settings/voice-profile/route";
import type { VoiceProfile } from "@/lib/ai/voice-profile-types";

const FULL: VoiceProfile = {
  greeting_patterns: ["Hey {first_name}", "Morning"],
  sign_off: "- Eddie",
  typical_sms_length_chars: 140,
  uses_emoji: false,
  uses_contractions: true,
  capitalization: "sentence",
  exclamation_frequency: "rare",
  common_phrases: ["let me pull that", "give me a day"],
  never_uses: ["reach out", "circle back"],
};

describe("normalizeProfile", () => {
  it("trusts the measured median over the model's estimate", () => {
    // The measured value is a fact we computed. An inflated estimate here
    // makes every generated draft too long.
    const p = normalizeProfile({ typical_sms_length_chars: 400 }, 118);
    expect(p.typical_sms_length_chars).toBe(118);
  });

  it("falls back to the model estimate when nothing was measured", () => {
    const p = normalizeProfile({ typical_sms_length_chars: 200 }, 0);
    expect(p.typical_sms_length_chars).toBe(200);
  });

  it("clamps an absurd estimate when nothing was measured", () => {
    expect(normalizeProfile({ typical_sms_length_chars: 5000 }, 0).typical_sms_length_chars).toBe(320);
    expect(normalizeProfile({ typical_sms_length_chars: 1 }, 0).typical_sms_length_chars).toBe(20);
  });

  it("defaults emoji to false, so a missing field never turns them on", () => {
    expect(normalizeProfile({}, 100).uses_emoji).toBe(false);
  });

  it("deduplicates case-insensitively and drops blanks", () => {
    const p = normalizeProfile(
      { common_phrases: ["Let me pull that", "let me pull that", "  ", "give me a day"] },
      100
    );
    expect(p.common_phrases).toEqual(["Let me pull that", "give me a day"]);
  });

  it("caps list lengths so one bad extraction cannot bloat every prompt", () => {
    const many = Array.from({ length: 50 }, (_, i) => `phrase ${i}`);
    expect(normalizeProfile({ common_phrases: many }, 100).common_phrases).toHaveLength(12);
    expect(normalizeProfile({ greeting_patterns: many }, 100).greeting_patterns).toHaveLength(8);
  });

  it("produces a complete profile from an empty object", () => {
    const p = normalizeProfile({}, 0);
    expect(Object.keys(p).sort()).toEqual(Object.keys(FULL).sort());
  });
});

describe("exemplarsFor", () => {
  const comms = [
    { content: "Hey Dana, following up on the appraisal.", direction: "outbound" },
    { content: "sounds good", direction: "inbound" },
    { content: "ok", direction: "outbound" }, // too short to carry style
    { content: "I pulled your credit, we're good on the 720 tier.", direction: "outbound" },
  ];

  it("returns only outbound messages", () => {
    const out = exemplarsFor(comms);
    expect(out.every((m) => !m.includes("sounds good"))).toBe(true);
    expect(out).toHaveLength(2);
  });

  it("drops messages too short to carry any style signal", () => {
    expect(exemplarsFor(comms)).not.toContain("ok");
  });

  it("takes the most recent, since style drifts over time", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      content: `This is outbound message number ${i}.`,
      direction: "outbound",
    }));
    const out = exemplarsFor(many, 10);
    expect(out).toHaveLength(10);
    expect(out[out.length - 1]).toContain("number 29");
  });

  it("returns an empty list when there is nothing outbound", () => {
    expect(exemplarsFor([{ content: "hi", direction: "inbound" }])).toEqual([]);
  });
});

describe("renderVoiceProfile", () => {
  it("states a safe default when no profile exists", () => {
    const text = renderVoiceProfile(null);
    expect(text).toContain("not yet profiled");
    expect(text).toContain("no emoji");
  });

  it("renders emoji as never when the profile says so", () => {
    expect(renderVoiceProfile(FULL)).toContain("Emoji: never");
  });

  it("renders emoji as occasional when the profile says so", () => {
    expect(renderVoiceProfile({ ...FULL, uses_emoji: true })).toContain(
      "Emoji: occasionally"
    );
  });

  it("includes the never_uses list, which the validator also enforces", () => {
    const text = renderVoiceProfile(FULL);
    expect(text).toContain("circle back");
  });

  it("omits sections that are empty rather than printing blanks", () => {
    const sparse = { ...FULL, common_phrases: [], greeting_patterns: [] };
    const text = renderVoiceProfile(sparse);
    expect(text).not.toContain("Phrases he actually uses");
    expect(text).not.toContain("Opens with");
  });
});

describe("renderStyleExemplars", () => {
  it("numbers the examples and collapses whitespace", () => {
    const text = renderStyleExemplars(["hey there\n\n  how's it going"]);
    expect(text).toContain("1. hey there how's it going");
  });

  it("says so plainly when there are none", () => {
    expect(renderStyleExemplars([])).toContain("none available");
  });

  it("tells the model to match register but not copy content", () => {
    expect(renderStyleExemplars(["sample"])).toContain("Do not copy their content");
  });
});

describe("validateProfileShape", () => {
  it("accepts a well-formed profile", () => {
    expect(validateProfileShape(FULL)).toEqual([]);
  });

  it("rejects a wrong type", () => {
    const bad = { ...FULL, uses_emoji: "yes" } as unknown as VoiceProfile;
    expect(validateProfileShape(bad).join()).toContain("uses_emoji");
  });

  it("rejects a value outside the allowed enum", () => {
    const bad = { ...FULL, capitalization: "SHOUTING" } as unknown as VoiceProfile;
    expect(validateProfileShape(bad).join()).toContain("capitalization");
  });

  it("reports a missing required field", () => {
    const bad = { ...FULL } as Partial<VoiceProfile>;
    delete bad.sign_off;
    expect(validateProfileShape(bad as VoiceProfile).join()).toContain("sign_off");
  });

  it("rejects a list supplied as a bare string", () => {
    const bad = { ...FULL, never_uses: "circle back" } as unknown as VoiceProfile;
    expect(validateProfileShape(bad).join()).toContain("never_uses");
  });
});
