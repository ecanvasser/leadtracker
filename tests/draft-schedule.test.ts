import { describe, it, expect } from "vitest";
import { draftDue, type DraftDueInput } from "@/lib/ai/draft-schedule";

/** Sunday 23 Aug 2026, 11:00 in Los Angeles. */
const NOW = new Date("2026-08-23T18:00:00Z");
const TZ = "America/Los_Angeles";
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function input(over: Partial<DraftDueInput> = {}): DraftDueInput {
  return {
    stage: "quoted_follow_up",
    stageChangedAt: hoursAgo(4),
    windowDays: 2,
    scheduleHours: [3, 24],
    lastInboundAt: null,
    // Older than the quote by default, so the anchor stays the quote and the
    // existing cases keep testing what they were written to test.
    lastMessageAt: hoursAgo(30),
    minHoursSinceLastMessage: 6,
    draftsGenerated: [],
    hasPendingDraft: false,
    now: NOW,
    timeZone: TZ,
    ...over,
  };
}

describe("the D5 schedule", () => {
  it("offers nothing in the first three hours", () => {
    const out = draftDue(input({ stageChangedAt: hoursAgo(1) }));
    expect(out.due).toBe(false);
    expect(out.reason).toContain("since the last touch");
  });

  it("offers the first draft once three hours have passed", () => {
    const out = draftDue(input({ stageChangedAt: hoursAgo(4) }));
    expect(out.due).toBe(true);
    expect(out.slotHours).toBe(3);
  });

  it("offers the second at twenty-four hours", () => {
    const out = draftDue(
      input({
        stageChangedAt: hoursAgo(25),
        // The 3h draft went out yesterday.
        draftsGenerated: [hoursAgo(22)],
      })
    );
    expect(out.due).toBe(true);
    expect(out.slotHours).toBe(24);
  });

  it("stops after the second — day two is the handoff, not a third draft", () => {
    const out = draftDue(
      input({
        stageChangedAt: hoursAgo(47),
        draftsGenerated: [hoursAgo(44), hoursAgo(23)],
      })
    );
    expect(out.due).toBe(false);
    expect(out.reason).toContain("every slot");
  });

  /*
   * A lead quoted on Friday evening whose first sweep is Monday has passed
   * both slots. One draft now and the second tomorrow — not two at once, and
   * not silently skipping the first.
   */
  it("consumes missed slots one at a time rather than all at once", () => {
    const out = draftDue(input({ stageChangedAt: hoursAgo(30) }));
    expect(out.due).toBe(true);
    expect(out.slotHours).toBe(3);
  });
});

describe("the two hard constraints from D5", () => {
  it("never drafts twice for the same lead on the same local day", () => {
    const out = draftDue(
      input({
        stageChangedAt: hoursAgo(30),
        draftsGenerated: [hoursAgo(2)],
      })
    );
    expect(out.due).toBe(false);
    expect(out.reason).toContain("today");
  });

  it("does allow the second draft once the day has turned over", () => {
    const out = draftDue(
      input({
        stageChangedAt: hoursAgo(30),
        // 20:00 the previous local evening.
        draftsGenerated: [hoursAgo(26)],
      })
    );
    expect(out.due).toBe(true);
  });

  it("never drafts while an earlier one is still pending approval", () => {
    const out = draftDue(input({ hasPendingDraft: true }));
    expect(out.due).toBe(false);
    expect(out.reason).toContain("pending");
  });

  it("checks the pending guard before anything that could produce a draft", () => {
    // Both would otherwise be due; pending has to win.
    const out = draftDue(
      input({ stageChangedAt: hoursAgo(30), hasPendingDraft: true })
    );
    expect(out.reason).toContain("pending");
  });
});

describe("a reply ends the schedule", () => {
  it("stops drafting once they answer", () => {
    const out = draftDue(input({ lastInboundAt: hoursAgo(1) }));
    expect(out.due).toBe(false);
    expect(out.reason).toContain("yours to write");
  });

  it("ignores an inbound from before the quote", () => {
    // They asked a question, he quoted them, they went quiet. Still due.
    const out = draftDue(
      input({ stageChangedAt: hoursAgo(4), lastInboundAt: hoursAgo(9) })
    );
    expect(out.due).toBe(true);
  });
});

describe("scope is enforced here too", () => {
  it.each(["hot_lead", "needs_quote", "app_in", "processing"] as const)(
    "refuses %s",
    (stage) => {
      expect(draftDue(input({ stage })).due).toBe(false);
    }
  );

  it("refuses a lead past the handoff window", () => {
    const out = draftDue(input({ stageChangedAt: hoursAgo(60) }));
    expect(out.due).toBe(false);
    expect(out.reason).toContain("window");
  });

  it("refuses a lead with no recorded pitch time", () => {
    expect(draftDue(input({ stageChangedAt: null })).due).toBe(false);
  });
});

describe("the schedule is configuration, not code", () => {
  it("honours a schedule Eddie has changed", () => {
    const out = draftDue(
      input({ scheduleHours: [8], stageChangedAt: hoursAgo(4) })
    );
    expect(out.due).toBe(false);

    const later = draftDue(
      input({ scheduleHours: [8], stageChangedAt: hoursAgo(9) })
    );
    expect(later.due).toBe(true);
    expect(later.slotHours).toBe(8);
  });

  it("an empty schedule turns drafting off without any other switch", () => {
    expect(draftDue(input({ scheduleHours: [] })).due).toBe(false);
  });

  it("does not care what order the hours are given in", () => {
    const out = draftDue(input({ scheduleHours: [24, 3], stageChangedAt: hoursAgo(4) }));
    expect(out.slotHours).toBe(3);
  });
});

/*
 * The anchor is the last message, not the quote.
 *
 * Eddie's ask: "if the last message was the day prior, we need a touchpoint.
 * If the last message was within the last 6 hours, we are probably ok to hold
 * off." Counting from the quote alone got this wrong in the one case that
 * matters — a lead quoted in the morning and messaged again after lunch.
 */
describe("holding off while the conversation is warm", () => {
  it("offers nothing when the last message was an hour ago", () => {
    const out = draftDue(
      input({ stageChangedAt: hoursAgo(30), lastMessageAt: hoursAgo(1) })
    );
    expect(out.due).toBe(false);
    expect(out.reason).toContain("1.0h ago");
  });

  it("counts Eddie's own outbound as a touch", () => {
    // The lead was quoted two days ago and every slot has long since passed,
    // but he messaged them this morning. A draft now would be his second
    // touch in three hours.
    const out = draftDue(
      input({ stageChangedAt: hoursAgo(48), lastMessageAt: hoursAgo(3) })
    );
    expect(out.due).toBe(false);
  });

  it("offers a touchpoint once the last message is a day old", () => {
    const out = draftDue(
      input({ stageChangedAt: hoursAgo(30), lastMessageAt: hoursAgo(26) })
    );
    expect(out.due).toBe(true);
  });

  it("re-anchors on a later message rather than counting from the quote", () => {
    /*
     * Quoted at 9am, messaged again at 2pm, and it is now 5pm. The three-hour
     * slot is eight hours past if measured from the quote; from the message it
     * has only just been reached, and the 6-hour floor holds it back.
     */
    const out = draftDue(
      input({ stageChangedAt: hoursAgo(8), lastMessageAt: hoursAgo(3) })
    );
    expect(out.due).toBe(false);
    expect(out.reason).toContain("3.0h ago");
  });

  it("still lets a reply end the schedule outright", () => {
    // Unchanged by any of this: a reply makes the lead Eddie's to write, and
    // that outranks the pacing rules rather than being one of them.
    const out = draftDue(
      input({
        stageChangedAt: hoursAgo(30),
        lastInboundAt: hoursAgo(26),
        lastMessageAt: hoursAgo(26),
      })
    );
    expect(out.due).toBe(false);
    expect(out.reason).toContain("yours to write");
  });
});
