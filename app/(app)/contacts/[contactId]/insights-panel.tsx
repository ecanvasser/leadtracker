"use client";

import { useState, useEffect } from "react";
import { Contact, Task } from "@/types/db";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
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
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  const [aiAnalysis, setAiAnalysis] = useState<AiAnalysis | null>(null);
  const [communications, setCommunications] = useState<CommunicationItem[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [addedTodos, setAddedTodos] = useState<Set<string>>(new Set());
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  useEffect(() => {
    if (contact.insights_enabled) {
      loadCachedInsights();
    }
  }, [contact.id]);

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
      const searchRes = await fetch("/api/insights/search-bonzo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: searchEmail.trim() }),
      });
      const searchData = await searchRes.json();

      const res = await fetch("/api/insights/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactId: contact.id,
          bonzoProspectId: searchResult.id,
          bonzoEmail: searchResult.email,
          bonzoProspectData: searchData.fullProspect ?? searchResult,
        }),
      });

      const data = await res.json();
      if (data.error) {
        toast.error(data.error);
      } else {
        setAiAnalysis(data.aiAnalysis);
        setCommunications(data.communications ?? []);
        setGeneratedAt(data.generatedAt);
        contact.insights_enabled = true;
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
  if (!contact.insights_enabled) {
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
            {contact.stage !== "hot_lead" && (
              <p className="text-xs text-muted-foreground/70 mt-1">
                Insights enrollment is available for Hot Leads only.
              </p>
            )}
          </div>

          {contact.stage === "hot_lead" && (
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
      <div className="space-y-4">
        {/* Status read */}
        <Card>
          <CardContent className="pt-4">
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
              Status
            </h3>
            <p className="text-sm">{aiAnalysis.status_read}</p>
          </CardContent>
        </Card>

        {/* Suggested next step */}
        <Card className="border-primary/20">
          <CardContent className="pt-4">
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
              <Lightbulb className="h-3 w-3" />
              Suggested Next Step
            </h3>
            <p className="text-sm">{aiAnalysis.suggested_next_step}</p>
          </CardContent>
        </Card>

        {/* Draft messages */}
        {aiAnalysis.draft_messages && aiAnalysis.draft_messages.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Draft Messages
            </h3>
            {aiAnalysis.draft_messages.map((draft, i) => (
              <Card key={i}>
                <CardContent className="pt-4">
                  <div className="flex items-center justify-between mb-2">
                    <Badge variant="secondary" className="text-[10px]">
                      {draft.channel === "email" ? (
                        <Mail className="h-2.5 w-2.5 mr-1" />
                      ) : (
                        <MessageSquare className="h-2.5 w-2.5 mr-1" />
                      )}
                      {draft.channel.toUpperCase()}
                    </Badge>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => handleCopy(draft.body, i)}
                    >
                      {copiedIndex === i ? (
                        <>
                          <Check className="h-3 w-3 mr-1" />
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
                    <p className="text-xs font-medium mb-1">
                      Subject: {draft.subject}
                    </p>
                  )}
                  <p className="text-sm whitespace-pre-wrap">{draft.body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Suggested to-dos */}
        {aiAnalysis.suggested_todos && aiAnalysis.suggested_todos.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Suggested To-Dos
            </h3>
            {aiAnalysis.suggested_todos.map((todo, i) => {
              const added = isTodoAdded(todo.title);
              return (
                <div
                  key={i}
                  className="flex items-center justify-between px-3 py-2 rounded-md border"
                >
                  <span className="text-sm">{todo.title}</span>
                  {added ? (
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Check className="h-3 w-3" />
                      Added
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
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
        )}
      </div>

      {/* Conversation timeline */}
      {sortedComms.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Conversation History ({sortedComms.length} messages)
          </h3>
          <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
            {sortedComms.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: CommunicationItem }) {
  const [expanded, setExpanded] = useState(false);
  const isOutbound = message.direction === "outbound";
  const content = message.content || "(no content)";
  const isLong = content.length > 200;

  return (
    <div className={`flex ${isOutbound ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-xs ${
          isOutbound
            ? "bg-primary/10 border border-primary/20"
            : "bg-muted border border-border"
        }`}
      >
        <div className="flex items-center gap-2 mb-1">
          <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
            {isOutbound ? (
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
