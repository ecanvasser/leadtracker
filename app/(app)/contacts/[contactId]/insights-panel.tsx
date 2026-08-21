"use client";

import { isOutbound } from "@/lib/bonzo/client";

import { useState, useEffect } from "react";
import { Contact, Task, isQueueEligible } from "@/types/db";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Search,
  RefreshCw,
  Copy,
  Check,
  Plus,
  ArrowRight,
  ArrowLeft as ArrowLeftIcon,
  Mail,
  MessageSquare,
  Sparkles,
  Loader2,
  Lightbulb,
  ChevronDown,
  ChevronUp,
  Pencil,
  ListChecks,
  MessageCircle,
  Activity,
} from "lucide-react";
import type { AiAnalysis } from "@/lib/insights/analyze";

interface InsightsPanelProps {
  contact: Contact;
  existingTasks: Task[];
  onAddTask: (title: string) => Promise<void>;
}

interface CommunicationItem {
  id: number;
  content: string | null;
  direction: string;
  type: string;
  subject: string | null;
  created_at: string;
}

interface BonzoSearchResult {
  id: number;
  name: string;
  email: string;
  phone: string | null;
}

export function InsightsPanel({
  contact,
  existingTasks,
  onAddTask,
}: InsightsPanelProps) {
  const [loading, setLoading] = useState(false);
  const [searchEmail, setSearchEmail] = useState("");
  const [searchResult, setSearchResult] = useState<BonzoSearchResult | null>(null);
  // The complete Bonzo record, kept so enrollment caches loan context rather
  // than the {id,name,email,phone} preview stub.
  const [fullProspect, setFullProspect] = useState<Record<string, unknown> | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  const [aiAnalysis, setAiAnalysis] = useState<AiAnalysis | null>(null);
  const [communications, setCommunications] = useState<CommunicationItem[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [addedTodos, setAddedTodos] = useState<Set<string>>(new Set());
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  // Enrollment is tracked in state rather than by assigning to the prop.
  // `contact.insights_enabled = true` mutated a value React owns, so the
  // component re-rendered from a prop that no longer matched the server.
  const [enabled, setEnabled] = useState(contact.insights_enabled);

  const [reviseOpen, setReviseOpen] = useState(false);
  const [reviseInstructions, setReviseInstructions] = useState("");
  const [revising, setRevising] = useState(false);

  useEffect(() => {
    setEnabled(contact.insights_enabled);
    if (contact.insights_enabled) {
      loadCachedInsights();
    }
  }, [contact.id, contact.insights_enabled]);

  async function loadCachedInsights() {
    setLoading(true);
    try {
      const res = await fetch(`/api/insights/${contact.id}`);
      const data = await res.json();
      if (data.cached) {
        setAiAnalysis(data.aiAnalysis);
        setCommunications(data.communications ?? []);
        setGeneratedAt(data.generatedAt);
      }
    } catch {
      toast.error("Failed to load insights");
    }
    setLoading(false);
  }

  async function handleSearch() {
    if (!searchEmail.trim()) return;
    setSearching(true);
    setSearchResult(null);
    setFullProspect(null);
    setSearchError(null);

    try {
      const res = await fetch("/api/insights/search-bonzo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: searchEmail.trim() }),
      });
      const data = await res.json();

      if (data.error) {
        setSearchError(data.error);
      } else if (!data.found) {
        setSearchError(
          "No prospect found with that email in Bonzo. Check the email and try again."
        );
      } else {
        setSearchResult(data.prospect);
        setFullProspect(data.fullProspect ?? null);
        if (data.fullProspect && !data.hasMortgageFields) {
          toast.warning(
            "Found in Bonzo, but this prospect has no mortgage details filled in. Drafts will have no loan context."
          );
        }
      }
    } catch {
      setSearchError("Search failed. Try again.");
    }
    setSearching(false);
  }

  async function handleEnable() {
    if (!searchResult) return;
    setLoading(true);

    try {
      // handleSearch already stored the complete prospect record. The previous
      // second call here read searchData.fullProspect, a key that endpoint did
      // not return, so it silently fell back to the {id,name,email,phone} stub
      // and every cached lead lost its mortgage context.
      const res = await fetch("/api/insights/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactId: contact.id,
          bonzoProspectId: searchResult.id,
          bonzoEmail: searchResult.email,
          bonzoProspectData: fullProspect ?? searchResult,
        }),
      });

      const data = await res.json();
      if (data.error) {
        toast.error(data.error);
      } else {
        setAiAnalysis(data.aiAnalysis);
        setCommunications(data.communications ?? []);
        setGeneratedAt(data.generatedAt);
        setEnabled(true);
        toast.success("Insights generated");
      }
    } catch {
      toast.error("Failed to enable insights");
    }
    setLoading(false);
  }

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const res = await fetch("/api/insights/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId: contact.id }),
      });
      const data = await res.json();

      if (data.error) {
        toast.error(data.error);
      } else {
        setAiAnalysis(data.aiAnalysis);
        setCommunications(data.communications ?? []);
        setGeneratedAt(data.generatedAt);
        toast.success("Insights refreshed");
      }
    } catch {
      toast.error("Failed to refresh insights");
    }
    setRefreshing(false);
  }

  async function handleRevise() {
    if (!reviseInstructions.trim() || !aiAnalysis?.draft_messages) return;
    setRevising(true);

    try {
      const res = await fetch("/api/insights/revise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactId: contact.id,
          drafts: aiAnalysis.draft_messages,
          instructions: reviseInstructions.trim(),
        }),
      });
      const data = await res.json();

      if (data.error) {
        toast.error(data.error);
      } else {
        setAiAnalysis({
          ...aiAnalysis,
          draft_messages: data.drafts,
        });
        setReviseOpen(false);
        setReviseInstructions("");
        toast.success("Drafts revised");
      }
    } catch {
      toast.error("Failed to revise drafts");
    }
    setRevising(false);
  }

  async function handleCopy(text: string, index: number) {
    await navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  }

  async function handleAddTodo(title: string) {
    await onAddTask(title);
    setAddedTodos((prev) => new Set(prev).add(title));
  }

  function isTodoAdded(title: string) {
    if (addedTodos.has(title)) return true;
    return existingTasks.some(
      (t) => t.title.toLowerCase().trim() === title.toLowerCase().trim()
    );
  }

  // State 1: Not enrolled
  if (!enabled) {
    return (
      <div className="p-4 md:p-6">
        <div className="max-w-md mx-auto py-12">
          <div className="text-center space-y-2 mb-6">
            <Sparkles className="h-8 w-8 text-muted-foreground mx-auto" />
            <h2 className="text-lg font-semibold">Sales insights</h2>
            <p className="text-sm text-muted-foreground">
              Connect this lead to Bonzo to get AI-powered follow-up
              recommendations.
            </p>
            {!isQueueEligible(contact.stage) && (
              <p className="text-xs text-muted-foreground/70 mt-1">
                Insights enrollment is available for Hot Leads only.
              </p>
            )}
          </div>

          {isQueueEligible(contact.stage) && (
            <div className="space-y-4">
              <div className="flex gap-2">
                <Input
                  type="email"
                  placeholder="Prospect's email in Bonzo"
                  value={searchEmail}
                  onChange={(e) => setSearchEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSearch();
                  }}
                />
                <Button onClick={handleSearch} disabled={searching || !searchEmail.trim()}>
                  {searching ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Search className="h-4 w-4" />
                  )}
                </Button>
              </div>

              {searchError && (
                <p className="text-sm text-destructive">{searchError}</p>
              )}

              {searchResult && (
                <Card>
                  <CardContent className="pt-4 space-y-3">
                    <div>
                      <p className="font-medium text-sm">{searchResult.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {searchResult.email}
                      </p>
                      {searchResult.phone && (
                        <p className="text-xs text-muted-foreground">
                          {searchResult.phone}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={handleEnable}
                        disabled={loading}
                      >
                        {loading ? (
                          <>
                            <Loader2 className="h-3 w-3 animate-spin mr-1" />
                            Generating insights...
                          </>
                        ) : (
                          "Connect & generate insights"
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setSearchResult(null);
                          setSearchEmail("");
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // State 2: Loading
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // State 2b: Enrolled but no cached insights
  if (!aiAnalysis) {
    return (
      <div className="flex items-center justify-center py-20">
        <Button onClick={handleRefresh} disabled={refreshing}>
          {refreshing ? (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          ) : (
            <Sparkles className="h-4 w-4 mr-2" />
          )}
          Generate insights
        </Button>
      </div>
    );
  }

  // State 3: Insights available
  const sortedComms = [...communications].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  return (
    <div className="p-4 md:p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium flex items-center gap-1.5">
            <Sparkles className="h-4 w-4" />
            Sales Insights
          </h2>
          {generatedAt && (
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Last updated:{" "}
              {new Date(generatedAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </p>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleRefresh}
          disabled={refreshing}
        >
          {refreshing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          )}
          Refresh
        </Button>
      </div>

      {/* AI Analysis */}
      <div className="space-y-5">
        {/* Status read */}
        <section>
          <div className="flex items-center gap-2 mb-2.5">
            <div className="flex items-center justify-center h-5 w-5 rounded bg-blue-500/10">
              <Activity className="h-3 w-3 text-blue-500" />
            </div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Status
            </h3>
          </div>
          <Card className="transition-colors hover:border-border">
            <CardContent className="pt-4 pb-4">
              <p className="text-sm leading-relaxed">{aiAnalysis.status_read}</p>
            </CardContent>
          </Card>
        </section>

        {/* Suggested next step */}
        <section>
          <div className="flex items-center gap-2 mb-2.5">
            <div className="flex items-center justify-center h-5 w-5 rounded bg-amber-500/10">
              <Lightbulb className="h-3 w-3 text-amber-500" />
            </div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Suggested Next Step
            </h3>
          </div>
          <Card className="border-primary/20 bg-primary/[0.02] transition-colors hover:border-primary/40">
            <CardContent className="pt-4 pb-4">
              <p className="text-sm leading-relaxed">{aiAnalysis.suggested_next_step}</p>
            </CardContent>
          </Card>
        </section>

        {/* Draft messages */}
        {aiAnalysis.draft_messages && aiAnalysis.draft_messages.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center gap-2">
                <div className="flex items-center justify-center h-5 w-5 rounded bg-green-500/10">
                  <MessageCircle className="h-3 w-3 text-green-500" />
                </div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Draft Messages
                </h3>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => setReviseOpen(true)}
              >
                <Pencil className="h-3 w-3 mr-1.5" />
                Revise
              </Button>
            </div>
            <div className="space-y-2.5">
              {aiAnalysis.draft_messages.map((draft, i) => (
                <Card
                  key={i}
                  className="transition-all hover:border-border hover:shadow-sm group/draft"
                >
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-center justify-between mb-2.5">
                      <Badge
                        variant="secondary"
                        className="text-[10px] gap-1"
                      >
                        {draft.channel === "email" ? (
                          <Mail className="h-2.5 w-2.5" />
                        ) : (
                          <MessageSquare className="h-2.5 w-2.5" />
                        )}
                        {draft.channel.toUpperCase()}
                      </Badge>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs opacity-0 group-hover/draft:opacity-100 transition-opacity"
                        onClick={() => handleCopy(draft.body, i)}
                      >
                        {copiedIndex === i ? (
                          <>
                            <Check className="h-3 w-3 mr-1 text-green-500" />
                            Copied
                          </>
                        ) : (
                          <>
                            <Copy className="h-3 w-3 mr-1" />
                            Copy
                          </>
                        )}
                      </Button>
                    </div>
                    {draft.subject && (
                      <p className="text-xs font-medium mb-1.5 text-muted-foreground">
                        Subject: {draft.subject}
                      </p>
                    )}
                    <p className="text-sm whitespace-pre-wrap leading-relaxed">
                      {draft.body}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        )}

        {/* Suggested to-dos */}
        {aiAnalysis.suggested_todos && aiAnalysis.suggested_todos.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-2.5">
              <div className="flex items-center justify-center h-5 w-5 rounded bg-purple-500/10">
                <ListChecks className="h-3 w-3 text-purple-500" />
              </div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Suggested To-Dos
              </h3>
            </div>
            <div className="space-y-1.5">
              {aiAnalysis.suggested_todos.map((todo, i) => {
                const added = isTodoAdded(todo.title);
                return (
                  <div
                    key={i}
                    className="flex items-center justify-between px-3 py-2.5 rounded-lg border transition-all hover:border-border hover:bg-muted/30 group/todo"
                  >
                    <span className="text-sm">{todo.title}</span>
                    {added ? (
                      <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                        <Check className="h-3 w-3" />
                        Added
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs opacity-0 group-hover/todo:opacity-100 transition-opacity"
                        onClick={() => handleAddTodo(todo.title)}
                      >
                        <Plus className="h-3 w-3 mr-1" />
                        Add task
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>

      {/* Conversation timeline */}
      {sortedComms.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-2.5">
            <div className="flex items-center justify-center h-5 w-5 rounded bg-muted">
              <MessageSquare className="h-3 w-3 text-muted-foreground" />
            </div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Conversation History
            </h3>
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-normal">
              {sortedComms.length}
            </Badge>
          </div>
          <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
            {sortedComms.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
          </div>
        </section>
      )}

      {/* Revise drafts dialog */}
      <Dialog open={reviseOpen} onOpenChange={setReviseOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Revise draft messages</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Describe the changes you want. The AI will rewrite the drafts based on your instructions.
            </p>
            <textarea
              value={reviseInstructions}
              onChange={(e) => setReviseInstructions(e.target.value)}
              placeholder='e.g. "Make it more casual", "Add urgency about rate lock expiring Friday", "Shorter — 2 sentences max"'
              rows={4}
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
            />
            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setReviseOpen(false);
                  setReviseInstructions("");
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleRevise}
                disabled={revising || !reviseInstructions.trim()}
              >
                {revising ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                    Revising...
                  </>
                ) : (
                  <>
                    <Pencil className="h-3 w-3 mr-1.5" />
                    Revise drafts
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MessageBubble({ message }: { message: CommunicationItem }) {
  const [expanded, setExpanded] = useState(false);
  const outbound = isOutbound(message.direction);
  const content = message.content || "(no content)";
  const isLong = content.length > 200;

  return (
    <div className={`flex ${outbound ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-xs transition-shadow hover:shadow-sm ${
          outbound
            ? "bg-primary/10 border border-primary/20"
            : "bg-muted border border-border"
        }`}
      >
        <div className="flex items-center gap-2 mb-1">
          <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
            {outbound ? (
              <ArrowRight className="h-2.5 w-2.5" />
            ) : (
              <ArrowLeftIcon className="h-2.5 w-2.5" />
            )}
            {message.type?.toUpperCase()}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {new Date(message.created_at).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </span>
        </div>
        {message.subject && (
          <p className="font-medium text-xs mb-0.5">
            {message.subject}
          </p>
        )}
        <p className="whitespace-pre-wrap break-words">
          {isLong && !expanded ? content.slice(0, 200) + "..." : content}
        </p>
        {isLong && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-[10px] text-muted-foreground hover:text-foreground mt-1 flex items-center gap-0.5"
          >
            {expanded ? (
              <>
                <ChevronUp className="h-2.5 w-2.5" /> Show less
              </>
            ) : (
              <>
                <ChevronDown className="h-2.5 w-2.5" /> Show more
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
