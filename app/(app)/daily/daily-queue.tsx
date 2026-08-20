"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import {
  Loader2,
  RefreshCw,
  Phone,
  Mail,
  MessageSquare,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  SkipForward,
  Send,
  CheckCircle2,
  ArrowRight,
  ArrowLeft,
  Zap,
  Clock,
  AlertTriangle,
  CalendarCheck,
} from "lucide-react";
import { LOAN_TYPE_LABELS, CRM_LABELS, type LoanType, type CRM } from "@/types/db";

interface QueueContact {
  name: string;
  loan_type: LoanType;
  crm: CRM;
  stage: string;
  created_at: string;
  insights_enabled: boolean;
}

interface QueueItem {
  id: string;
  contact_id: string;
  priority_rank: number;
  priority_reason: string;
  action_type: "sms" | "email" | "call";
  draft_message: string | null;
  call_talking_points: string | null;
  status: string;
  lane: string | null;
  touch_label: string | null;
  decision_trace: DecisionTrace | null;
  contacts: QueueContact;
}

/** Audit record written at generation time. See 1.6 in the rework spec. */
interface DecisionTrace {
  lane?: string;
  rule_fired?: string;
  lead_age_days?: number;
  priority?: {
    score?: number;
    reason?: string;
    base_score?: number | null;
    is_overdue?: boolean;
  };
  lead_state?: {
    lead_temp?: string;
    blocker?: string;
    blocker_confidence?: string;
    blocker_evidence?: string | null;
    why_now?: string;
    recommended_action?: string;
  } | null;
  drafting?: {
    model?: string | null;
    prompt_version?: string;
    temperature?: number | null;
    attempts?: number | null;
    validated?: boolean | null;
    violations?: { rule: string; detail: string }[];
    input_tokens?: number | null;
    output_tokens?: number | null;
    latency_ms?: number | null;
  };
  inputs?: Record<string, unknown>;
  generated_at?: string;
}

interface QueueSummary {
  total: number;
  sent: number;
  skipped: number;
  done: number;
  pending: number;
  generated: boolean;
}

interface DailyQueueProps {
  userId: string;
}

function getPriorityStyle(reason: string): {
  color: string;
  bg: string;
  border: string;
  icon: React.ReactNode;
} {
  const r = reason.toLowerCase();
  if (r.includes("unanswered")) {
    return {
      color: "text-red-600 dark:text-red-400",
      bg: "bg-red-500/10",
      border: "border-red-500/30",
      icon: <AlertTriangle className="h-3.5 w-3.5" />,
    };
  }
  if (r.includes("day 1") || r.includes("overdue")) {
    return {
      color: "text-orange-600 dark:text-orange-400",
      bg: "bg-orange-500/10",
      border: "border-orange-500/30",
      icon: <Zap className="h-3.5 w-3.5" />,
    };
  }
  if (r.includes("day 2") || r.includes("day 3") || r.includes("early")) {
    return {
      color: "text-amber-600 dark:text-amber-400",
      bg: "bg-amber-500/10",
      border: "border-amber-500/30",
      icon: <Clock className="h-3.5 w-3.5" />,
    };
  }
  return {
    color: "text-blue-600 dark:text-blue-400",
    bg: "bg-blue-500/10",
    border: "border-blue-500/30",
    icon: <CalendarCheck className="h-3.5 w-3.5" />,
  };
}

function getActionIcon(type: string) {
  switch (type) {
    case "sms":
      return <MessageSquare className="h-5 w-5" />;
    case "email":
      return <Mail className="h-5 w-5" />;
    case "call":
      return <Phone className="h-5 w-5" />;
    default:
      return <MessageSquare className="h-5 w-5" />;
  }
}

function getLeadAge(createdAt: string): string {
  const days = Math.floor(
    (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24)
  );
  if (days === 0) return "Today";
  if (days === 1) return "1 day";
  return `${days} days`;
}

export function DailyQueue({ userId }: DailyQueueProps) {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [currentItem, setCurrentItem] = useState<QueueItem | null>(null);
  const [summary, setSummary] = useState<QueueSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [actioning, setActioning] = useState(false);
  const [editedMessage, setEditedMessage] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [traceOpen, setTraceOpen] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const router = useRouter();

  const loadQueue = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/daily-queue");
      const data = await res.json();

      if (data.generated && data.queue.length > 0) {
        setQueue(data.queue);
        const pending = data.queue.filter((i: QueueItem) => i.status === "pending");
        setCurrentItem(pending[0] ?? null);
      } else {
        setQueue([]);
        setCurrentItem(null);
      }
    } catch {
      toast.error("Failed to load queue");
    }
    setLoading(false);
  }, []);

  const loadSummary = useCallback(async () => {
    try {
      const res = await fetch("/api/daily-queue/summary");
      const data = await res.json();
      setSummary(data);
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    loadQueue();
    loadSummary();
  }, [loadQueue, loadSummary]);

  useEffect(() => {
    if (currentItem?.draft_message) {
      setEditedMessage(currentItem.draft_message);
    } else {
      setEditedMessage("");
    }
    setIsEditing(false);
    setCopied(false);
    setContextOpen(false);
    setTraceOpen(false);
  }, [currentItem?.id]);

  async function handleGenerate(force = false) {
    setGenerating(true);
    try {
      const res = await fetch("/api/daily-queue/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const data = await res.json();

      if (data.error) {
        if (res.status === 429 && !force) {
          toast.error("Queue was recently generated. Click again to force refresh.");
          setGenerating(false);
          return;
        }
        toast.error(data.error);
      } else {
        setQueue(data.queue ?? []);
        const pending = (data.queue ?? []).filter((i: QueueItem) => i.status === "pending");
        setCurrentItem(pending[0] ?? null);
        toast.success(`Queue generated — ${data.queue?.length ?? 0} items`);
      }
    } catch {
      toast.error("Failed to generate queue");
    }
    setGenerating(false);
    loadSummary();
  }

  async function handleAction(action: "send" | "edit_send" | "skip" | "done") {
    if (!currentItem) return;
    setActioning(true);

    if (action === "send" || action === "edit_send") {
      const textToCopy = action === "edit_send" ? editedMessage : (currentItem.draft_message ?? "");
      if (textToCopy && currentItem.action_type !== "call") {
        await navigator.clipboard.writeText(textToCopy);
        // TODO: Bonzo's POST /v3/prospects/{id}/sms and POST /v3/prospects/{id}/email
        // endpoints exist for future direct sending
      }
    }

    try {
      const res = await fetch("/api/daily-queue/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queueItemId: currentItem.id,
          action,
          editedMessage: action === "edit_send" ? editedMessage : undefined,
        }),
      });
      const data = await res.json();

      if (action === "send" || action === "edit_send") {
        if (currentItem.action_type !== "call") {
          toast.success("Message copied — paste it in Bonzo");
        } else {
          toast.success("Call logged");
        }
      } else if (action === "skip") {
        toast("Skipped", { description: "Moving to next" });
      } else {
        toast.success("Marked as done");
      }

      setTransitioning(true);
      setTimeout(() => {
        if (data.next) {
          setCurrentItem(data.next);
        } else {
          setCurrentItem(null);
        }
        setTransitioning(false);
      }, 300);

      setQueue((prev) =>
        prev.map((item) =>
          item.id === currentItem.id
            ? { ...item, status: action === "skip" ? "skipped" : "sent" }
            : item
        )
      );
    } catch {
      toast.error("Action failed");
    }

    setActioning(false);
    loadSummary();
  }

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const completedCount = summary ? summary.sent + summary.skipped + summary.done : 0;
  const progress = summary && summary.total > 0 ? (completedCount / summary.total) * 100 : 0;

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // No queue generated yet
  if (queue.length === 0 && !summary?.generated) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-4 max-w-md">
          <div className="mx-auto h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
            <Zap className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-xl font-semibold">Daily Queue</h1>
          <p className="text-sm text-muted-foreground">
            Generate your daily outreach queue based on lead cadence. The engine
            prioritizes unanswered replies, new leads, and overdue touches.
          </p>
          <Button onClick={() => handleGenerate(true)} disabled={generating} size="lg">
            {generating ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Generating queue...
              </>
            ) : (
              <>
                <Zap className="h-4 w-4 mr-2" />
                Generate today's queue
              </>
            )}
          </Button>
        </div>
      </div>
    );
  }

  // Queue complete
  if (!currentItem && queue.length > 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-4 max-w-md">
          <div className="mx-auto h-12 w-12 rounded-full bg-green-500/10 flex items-center justify-center">
            <CheckCircle2 className="h-6 w-6 text-green-500" />
          </div>
          <h1 className="text-xl font-semibold">All caught up</h1>
          <p className="text-sm text-muted-foreground">
            {summary &&
              `Sent ${summary.sent} follow-up${summary.sent !== 1 ? "s" : ""}${
                summary.done > 0 ? `, logged ${summary.done} action${summary.done !== 1 ? "s" : ""}` : ""
              }${summary.skipped > 0 ? `, skipped ${summary.skipped}` : ""}.`}
          </p>
          <p className="text-xs text-muted-foreground">
            Check back this afternoon for remaining touches.
          </p>
          <div className="flex gap-2 justify-center">
            <Button variant="outline" onClick={() => router.push("/board")}>
              Back to board
            </Button>
            <Button variant="outline" onClick={() => handleGenerate(true)} disabled={generating}>
              {generating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
              )}
              Refresh queue
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Active queue
  const contact = currentItem?.contacts;
  const priority = currentItem ? getPriorityStyle(currentItem.priority_reason) : null;

  // Parse email subject from draft_message if present
  let emailSubject = "";
  let messageBody = currentItem?.draft_message ?? "";
  if (currentItem?.action_type === "email" && messageBody.startsWith("Subject: ")) {
    const splitIdx = messageBody.indexOf("\n\n");
    if (splitIdx !== -1) {
      emailSubject = messageBody.slice(9, splitIdx);
      messageBody = messageBody.slice(splitIdx + 2);
    }
  }

  // Also update editedMessage on first render without subject prefix
  const displayEditMessage = isEditing ? editedMessage : messageBody;

  return (
    <div className="flex-1 flex flex-col">
      {/* Top bar */}
      <div className="border-b border-border/50 px-4 md:px-6 py-3">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h1 className="text-sm font-medium">{today}</h1>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => handleGenerate(true)}
            disabled={generating}
          >
            {generating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            )}
            Refresh
          </Button>
        </div>

        {summary && summary.total > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {completedCount} of {summary.total} leads reviewed
              </span>
              <span>{Math.round(progress)}%</span>
            </div>
            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="flex gap-2 flex-wrap">
              {summary.sent > 0 && (
                <Badge variant="secondary" className="text-[10px] font-normal gap-1">
                  <Send className="h-2.5 w-2.5" />
                  {summary.sent} sent
                </Badge>
              )}
              {summary.skipped > 0 && (
                <Badge variant="secondary" className="text-[10px] font-normal gap-1">
                  <SkipForward className="h-2.5 w-2.5" />
                  {summary.skipped} skipped
                </Badge>
              )}
              {summary.done > 0 && (
                <Badge variant="secondary" className="text-[10px] font-normal gap-1">
                  <Check className="h-2.5 w-2.5" />
                  {summary.done} done
                </Badge>
              )}
              {summary.pending > 0 && (
                <Badge variant="outline" className="text-[10px] font-normal gap-1">
                  <Clock className="h-2.5 w-2.5" />
                  {summary.pending} remaining
                </Badge>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Main card area */}
      {currentItem && contact && priority && (
        <div className="flex-1 flex items-start justify-center p-4 md:p-8 overflow-y-auto">
          <div
            className={`w-full max-w-2xl transition-all duration-300 ${
              transitioning ? "opacity-0 translate-x-8" : "opacity-100 translate-x-0"
            }`}
          >
            <Card className="overflow-hidden">
              {/* Priority stripe */}
              <div className={`px-4 py-2.5 ${priority.bg} border-b ${priority.border}`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={priority.color}>{priority.icon}</span>
                  <span className={`text-xs font-semibold uppercase tracking-wider ${priority.color}`}>
                    {currentItem.priority_reason}
                  </span>
                  {/* Computed by the engine and previously never displayed. */}
                  {currentItem.touch_label && (
                    <Badge variant="outline" className="text-[10px] py-0">
                      {currentItem.touch_label}
                    </Badge>
                  )}
                  {currentItem.decision_trace?.lead_state?.lead_temp && (
                    <Badge variant="secondary" className="text-[10px] py-0">
                      {currentItem.decision_trace.lead_state.lead_temp.replace(/_/g, " ")}
                    </Badge>
                  )}
                  {currentItem.decision_trace?.lead_state?.blocker &&
                    currentItem.decision_trace.lead_state.blocker !== "none" && (
                      <Badge variant="destructive" className="text-[10px] py-0">
                        {currentItem.decision_trace.lead_state.blocker.replace(/_/g, " ")}
                      </Badge>
                    )}
                  {currentItem.decision_trace?.drafting?.validated === false && (
                    <Badge variant="destructive" className="text-[10px] py-0">
                      unvalidated draft
                    </Badge>
                  )}
                </div>
                {currentItem.decision_trace?.lead_state?.why_now && (
                  <p className="text-[11px] text-muted-foreground mt-1.5">
                    {currentItem.decision_trace.lead_state.why_now}
                  </p>
                )}
              </div>

              <CardContent className="pt-5 pb-5 space-y-5">
                {/* Contact info row */}
                <div className="flex items-start justify-between">
                  <div>
                    <h2 className="text-lg font-semibold">{contact.name}</h2>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      <Badge variant="secondary" className="text-[10px] font-normal">
                        {LOAN_TYPE_LABELS[contact.loan_type]}
                      </Badge>
                      <Badge variant="outline" className="text-[10px] font-normal">
                        {CRM_LABELS[contact.crm]}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">
                        Hot lead · {getLeadAge(contact.created_at)}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted">
                    {getActionIcon(currentItem.action_type)}
                    <span className="text-sm font-medium uppercase">
                      {currentItem.action_type}
                    </span>
                  </div>
                </div>

                {/* Draft message for SMS/Email */}
                {currentItem.action_type !== "call" && (
                  <div className="space-y-2">
                    {currentItem.action_type === "email" && emailSubject && (
                      <div className="text-xs text-muted-foreground">
                        <span className="font-medium">Subject:</span> {emailSubject}
                      </div>
                    )}
                    {isEditing ? (
                      <textarea
                        value={editedMessage}
                        onChange={(e) => setEditedMessage(e.target.value)}
                        rows={6}
                        className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
                        autoFocus
                      />
                    ) : (
                      <div
                        onClick={() => {
                          setIsEditing(true);
                          setEditedMessage(messageBody);
                        }}
                        className="rounded-md border border-border/60 bg-muted/30 px-3 py-2.5 text-sm whitespace-pre-wrap leading-relaxed cursor-text hover:border-border transition-colors"
                      >
                        {messageBody || "(No draft available)"}
                      </div>
                    )}
                    <p className="text-[10px] text-muted-foreground">
                      Click to edit · Message will be copied to clipboard on send
                    </p>
                  </div>
                )}

                {/* Call talking points */}
                {currentItem.action_type === "call" && currentItem.call_talking_points && (
                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Talking Points
                    </h3>
                    <div className="rounded-md border border-border/60 bg-muted/30 px-4 py-3 text-sm whitespace-pre-wrap leading-relaxed">
                      {currentItem.call_talking_points}
                    </div>
                  </div>
                )}

                {/* Action buttons */}
                <div className="flex gap-2 pt-1">
                  {currentItem.action_type === "call" ? (
                    <Button
                      className="flex-1"
                      onClick={() => handleAction("done")}
                      disabled={actioning}
                    >
                      {actioning ? (
                        <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                      ) : (
                        <Phone className="h-4 w-4 mr-1.5" />
                      )}
                      Log call
                    </Button>
                  ) : isEditing && editedMessage !== messageBody ? (
                    <Button
                      className="flex-1"
                      onClick={() => handleAction("edit_send")}
                      disabled={actioning}
                    >
                      {actioning ? (
                        <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                      ) : (
                        <Send className="h-4 w-4 mr-1.5" />
                      )}
                      Send edited
                    </Button>
                  ) : (
                    <Button
                      className="flex-1"
                      onClick={() => handleAction("send")}
                      disabled={actioning}
                    >
                      {actioning ? (
                        <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                      ) : copied ? (
                        <Check className="h-4 w-4 mr-1.5" />
                      ) : (
                        <Copy className="h-4 w-4 mr-1.5" />
                      )}
                      Copy & send
                    </Button>
                  )}

                  <Button
                    variant="outline"
                    onClick={() => handleAction("skip")}
                    disabled={actioning}
                  >
                    <SkipForward className="h-4 w-4 mr-1.5" />
                    Skip
                  </Button>

                  {currentItem.action_type !== "call" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs text-muted-foreground"
                      onClick={() => handleAction("done")}
                      disabled={actioning}
                    >
                      Already handled
                    </Button>
                  )}
                </div>

                {/* Context preview (collapsible) */}
                <div className="border-t border-border/50 pt-3">
                  <button
                    onClick={() => setContextOpen(!contextOpen)}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-full"
                  >
                    {contextOpen ? (
                      <ChevronUp className="h-3 w-3" />
                    ) : (
                      <ChevronDown className="h-3 w-3" />
                    )}
                    Recent conversation context
                  </button>

                  {contextOpen && (
                    <div className="mt-3 space-y-1.5 max-h-[200px] overflow-y-auto">
                      <p className="text-[10px] text-muted-foreground italic">
                        Context from cached insights — open the contact page for full history.
                      </p>
                      <Button
                        variant="link"
                        size="sm"
                        className="text-xs p-0 h-auto"
                        onClick={() => router.push(`/contacts/${currentItem.contact_id}`)}
                      >
                        View full contact details
                        <ArrowRight className="h-3 w-3 ml-1" />
                      </Button>
                    </div>
                  )}
                </div>

                {/* Why this fired. When a suggestion is bad, this is how to
                    see which rule produced it and on what inputs. */}
                {currentItem.decision_trace && (
                  <div className="border-t border-border/50 pt-3">
                    <button
                      onClick={() => setTraceOpen(!traceOpen)}
                      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-full"
                    >
                      {traceOpen ? (
                        <ChevronUp className="h-3 w-3" />
                      ) : (
                        <ChevronDown className="h-3 w-3" />
                      )}
                      Why this surfaced
                    </button>

                    {traceOpen && (
                      <DecisionTracePanel trace={currentItem.decision_trace} />
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Renders the audit record for a queue item.
 *
 * Deliberately plain: this is read by a person who thinks a suggestion is
 * wrong and wants to know why it fired, so it favours legibility over density.
 */
function DecisionTracePanel({ trace }: { trace: DecisionTrace }) {
  const rows: [string, string][] = [];

  if (trace.lane) rows.push(["Lane", trace.lane.replace(/_/g, " ")]);
  if (trace.rule_fired) rows.push(["Rule fired", String(trace.rule_fired).replace(/_/g, " ")]);
  if (typeof trace.lead_age_days === "number") {
    rows.push(["Lead age", `${trace.lead_age_days} days`]);
  }
  if (trace.priority?.score !== undefined) {
    const base = trace.priority.base_score;
    rows.push([
      "Priority",
      `${trace.priority.score}${base != null ? ` (base ${base}${trace.priority.is_overdue ? " + 400 overdue" : ""})` : ""}`,
    ]);
  }
  if (trace.lead_state?.blocker_confidence) {
    rows.push(["Blocker confidence", trace.lead_state.blocker_confidence]);
  }

  const d = trace.drafting;
  if (d?.model) {
    rows.push([
      "Model",
      `${d.model}${d.prompt_version ? ` · prompt v${d.prompt_version}` : ""}${
        d.temperature != null ? ` · temp ${d.temperature}` : ""
      }`,
    ]);
  }
  if (d?.attempts != null) {
    rows.push(["Draft attempts", d.attempts === 1 ? "1 (passed first time)" : String(d.attempts)]);
  }
  if (d?.input_tokens != null || d?.output_tokens != null) {
    rows.push([
      "Tokens",
      `${d.input_tokens ?? "?"} in / ${d.output_tokens ?? "?"} out${
        d.latency_ms != null ? ` · ${(d.latency_ms / 1000).toFixed(1)}s` : ""
      }`,
    ]);
  }

  return (
    <div className="mt-3 space-y-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-mono">{value}</dd>
          </div>
        ))}
      </dl>

      {trace.lead_state?.blocker_evidence && (
        <div className="text-[11px]">
          <p className="text-muted-foreground mb-0.5">Blocker evidence (verbatim)</p>
          <blockquote className="border-l-2 border-border pl-2 italic">
            {trace.lead_state.blocker_evidence}
          </blockquote>
        </div>
      )}

      {d?.violations && d.violations.length > 0 && (
        <div className="text-[11px]">
          <p className="text-muted-foreground mb-0.5">
            Draft shown despite failing validation
          </p>
          <ul className="list-disc pl-4 space-y-0.5">
            {d.violations.map((v, i) => (
              <li key={i}>
                <span className="font-mono">{v.rule}</span> — {v.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
