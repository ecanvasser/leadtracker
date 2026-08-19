import { Contact } from "@/types/db";

export interface OutreachLogEntry {
  id: string;
  contact_id: string;
  action_type: "sms" | "email" | "call";
  status: string;
  created_at: string;
}

export interface BonzoCommEntry {
  id: number;
  content: string | null;
  direction: string;
  type: string;
  created_at: string;
}

export interface QueueAction {
  contactId: string;
  actionType: "sms" | "email" | "call";
  priorityScore: number;
  priorityReason: string;
  touchLabel: string | null;
}

interface CadenceTarget {
  messagesTouches: number;
  calls: number;
  channelHint: ("sms" | "email")[];
}

function getLeadAgeDays(contact: Contact): number {
  const created = new Date(contact.created_at);
  const now = new Date();
  const diffMs = now.getTime() - created.getTime();
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

function getDayOfWeek(): number {
  return new Date().getDay();
}

function isSaturday(): boolean {
  return getDayOfWeek() === 6;
}

function isSunday(): boolean {
  return getDayOfWeek() === 0;
}

function getCadenceTarget(ageDays: number): CadenceTarget {
  if (ageDays === 0) {
    return { messagesTouches: 3, calls: 2, channelHint: ["sms", "email", "sms"] };
  }
  if (ageDays <= 3) {
    return { messagesTouches: 2, calls: 1, channelHint: ["sms", "email"] };
  }
  if (ageDays <= 7) {
    return { messagesTouches: 1, calls: 1, channelHint: ["sms"] };
  }
  if (ageDays <= 14) {
    return { messagesTouches: 1, calls: 0.5, channelHint: ["email"] };
  }
  if (ageDays <= 21) {
    return { messagesTouches: 0.5, calls: 0.3, channelHint: ["sms"] };
  }
  if (ageDays <= 30) {
    return { messagesTouches: 0.4, calls: 0.15, channelHint: ["email"] };
  }
  return { messagesTouches: 0.15, calls: 0.07, channelHint: ["email"] };
}

function shouldActToday(frequency: number, ageDays: number): number {
  if (frequency >= 1) return Math.round(frequency);
  const period = Math.round(1 / frequency);
  return ageDays % period === 0 ? 1 : 0;
}

function getLastChannelUsed(todayLog: OutreachLogEntry[]): "sms" | "email" | null {
  const msgs = todayLog.filter((e) => e.action_type !== "call");
  if (msgs.length === 0) return null;
  return msgs[msgs.length - 1].action_type as "sms" | "email";
}

function alternateChannel(last: "sms" | "email" | null): "sms" | "email" {
  if (last === "sms") return "email";
  return "sms";
}

function detectUnansweredReply(
  bonzoComms: BonzoCommEntry[]
): { hasUnanswered: boolean; lastReplyAge: string | null } {
  if (bonzoComms.length === 0) return { hasUnanswered: false, lastReplyAge: null };

  const sorted = [...bonzoComms].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  const lastMsg = sorted[0];
  if (lastMsg.direction === "inbound") {
    const replyTime = new Date(lastMsg.created_at);
    const now = new Date();
    const diffHours = Math.round((now.getTime() - replyTime.getTime()) / (1000 * 60 * 60));
    const ageStr = diffHours < 1 ? "just now" : diffHours === 1 ? "1 hour ago" : `${diffHours} hours ago`;
    return { hasUnanswered: true, lastReplyAge: ageStr };
  }

  return { hasUnanswered: false, lastReplyAge: null };
}

function checkOverdue(
  ageDays: number,
  recentLog: OutreachLogEntry[]
): boolean {
  if (ageDays === 0) return false;

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];

  const yesterdayActions = recentLog.filter((e) => {
    const d = new Date(e.created_at).toISOString().split("T")[0];
    return d === yesterdayStr && e.status !== "skipped";
  });

  const target = getCadenceTarget(ageDays - 1);
  const expectedTouches = shouldActToday(target.messagesTouches, ageDays - 1);

  return yesterdayActions.length < expectedTouches && expectedTouches > 0;
}

export function calculateTodayActions(
  contact: Contact,
  outreachHistory: OutreachLogEntry[],
  bonzoCommunication: BonzoCommEntry[]
): QueueAction[] {
  if (isSunday()) return [];

  const ageDays = getLeadAgeDays(contact);
  const saturday = isSaturday();
  const cadence = getCadenceTarget(ageDays);

  const todayStr = new Date().toISOString().split("T")[0];
  const todayLog = outreachHistory.filter((e) => {
    const d = new Date(e.created_at).toISOString().split("T")[0];
    return d === todayStr;
  });

  const todayMessages = todayLog.filter((e) => e.action_type !== "call" && e.status !== "skipped");
  const todayCalls = todayLog.filter((e) => e.action_type === "call" && e.status !== "skipped");

  const actions: QueueAction[] = [];

  const { hasUnanswered, lastReplyAge } = detectUnansweredReply(bonzoCommunication);

  if (hasUnanswered) {
    const lastChannel = getLastChannelUsed(todayLog);
    const replyChannel = alternateChannel(lastChannel);
    actions.push({
      contactId: contact.id,
      actionType: replyChannel,
      priorityScore: 1000,
      priorityReason: `Unanswered reply from ${lastReplyAge}`,
      touchLabel: null,
    });
    return actions;
  }

  let targetMessages = shouldActToday(cadence.messagesTouches, ageDays);
  let targetCalls = shouldActToday(cadence.calls, ageDays);

  if (saturday) {
    targetMessages = Math.min(targetMessages, 1);
    targetCalls = 0;
  }

  const remainingMessages = Math.max(0, targetMessages - todayMessages.length);
  const remainingCalls = Math.max(0, targetCalls - todayCalls.length);

  const isOverdue = checkOverdue(ageDays, outreachHistory);

  let baseScore = 100;
  if (ageDays === 0) baseScore = 500;
  else if (ageDays <= 3) baseScore = 300;
  else if (ageDays <= 7) baseScore = 200;
  else if (ageDays <= 14) baseScore = 100;
  else baseScore = 50;

  if (isOverdue) baseScore += 400;

  const lastChannel = getLastChannelUsed(todayLog);
  const totalTouches = remainingMessages + remainingCalls;

  for (let i = 0; i < remainingMessages; i++) {
    let channel: "sms" | "email";
    if (cadence.channelHint[todayMessages.length + i]) {
      channel = cadence.channelHint[todayMessages.length + i];
    } else {
      const prev = i === 0 ? lastChannel : (actions[actions.length - 1]?.actionType === "sms" ? "sms" : "email");
      channel = alternateChannel(prev);
    }

    let reason: string;
    if (isOverdue) {
      reason = `Overdue — missed yesterday's cadence`;
    } else if (ageDays === 0) {
      reason = `Day 1 — speed to lead`;
    } else if (ageDays <= 3) {
      reason = `Day ${ageDays + 1} — early cadence`;
    } else {
      reason = `Scheduled touch`;
    }

    const touchNum = todayMessages.length + i + 1;
    const touchLabel = totalTouches > 1 ? `Touch ${touchNum} of ${targetMessages + targetCalls}` : null;

    actions.push({
      contactId: contact.id,
      actionType: channel,
      priorityScore: baseScore - i,
      priorityReason: reason,
      touchLabel,
    });
  }

  for (let i = 0; i < remainingCalls; i++) {
    let reason: string;
    if (ageDays === 0) reason = "Day 1 — intro call";
    else if (ageDays <= 3) reason = `Day ${ageDays + 1} — follow-up call`;
    else reason = "Scheduled call";

    const touchNum = todayMessages.length + remainingMessages + todayCalls.length + i + 1;
    const touchLabel = totalTouches > 1 ? `Touch ${touchNum} of ${targetMessages + targetCalls}` : null;

    actions.push({
      contactId: contact.id,
      actionType: "call",
      priorityScore: baseScore + 25 - i,
      priorityReason: reason,
      touchLabel,
    });
  }

  return actions;
}
