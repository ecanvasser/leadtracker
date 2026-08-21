"use client";

import { useState, useEffect, useCallback } from "react";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { createClient } from "@/lib/supabase/client";
import {
  Contact,
  TaskWithContact,
  PipelineStage,
  AllStages,
  PIPELINE_STAGES,
  ALL_STAGES,
  STAGE_LABELS,
  ADVERSE_REASONS,
  ADVERSE_REASON_LABELS,
  isQueueEligible,
  type AdverseReason,
} from "@/types/db";
import type { BoardMeta } from "@/app/(app)/board/page";
import { StageColumn } from "./stage-column";
import { TodoColumn } from "./todo-column";
import { ContactCard } from "./contact-card";
import { ContactDialog } from "@/components/contact/contact-dialog";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { Zap, Search, X } from "lucide-react";

interface BoardProps {
  initialContacts: Contact[];
  initialTasks: TaskWithContact[];
  initialTaskCounts: Record<string, number>;
  initialMeta: Record<string, BoardMeta>;
  userId: string;
}

/** Board filters. "excluded" surfaces hot leads the queue cannot see. */
type BoardFilter = "all" | "excluded" | "blocked" | "in_market" | "untouched";

const FILTER_LABELS: Record<BoardFilter, string> = {
  all: "All",
  excluded: "Not in queue",
  in_market: "In market",
  blocked: "Blocked",
  untouched: "Never contacted",
};

export function Board({
  initialContacts,
  initialTasks,
  initialTaskCounts,
  initialMeta,
  userId,
}: BoardProps) {
  const [contacts, setContacts] = useState<Contact[]>(initialContacts);
  const [tasks, setTasks] = useState<TaskWithContact[]>(initialTasks);
  const [taskCounts, setTaskCounts] = useState(initialTaskCounts);
  const [activeContact, setActiveContact] = useState<Contact | null>(null);
  const [showNewContact, setShowNewContact] = useState(false);
  const [queuePending, setQueuePending] = useState(0);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<BoardFilter>("all");
  const [adverseFor, setAdverseFor] = useState<Contact | null>(null);
  const supabase = createClient();
  const router = useRouter();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const refreshTasks = useCallback(async () => {
    const { data } = await supabase
      .from("tasks")
      .select("*, contacts(name, loan_type)")
      .eq("is_done", false)
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true });
    if (data) {
      setTasks(data as TaskWithContact[]);
      const counts: Record<string, number> = {};
      for (const t of data) {
        counts[t.contact_id] = (counts[t.contact_id] || 0) + 1;
      }
      setTaskCounts(counts);
    }
  }, [supabase]);

  useEffect(() => {
    fetch("/api/daily-queue/summary")
      .then((r) => r.json())
      .then((d) => { if (d.pending) setQueuePending(d.pending); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const contactChannel = supabase
      .channel("contacts-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "contacts" },
        async () => {
          const { data } = await supabase
            .from("contacts")
            .select("*")
            .order("position", { ascending: true });
          if (data) setContacts(data as Contact[]);
        }
      )
      .subscribe();

    const taskChannel = supabase
      .channel("tasks-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tasks" },
        () => refreshTasks()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(contactChannel);
      supabase.removeChannel(taskChannel);
    };
  }, [supabase, refreshTasks]);

  /**
   * 4.5 — search and filter.
   *
   * Applied to what a column renders rather than to `contacts` itself, so drag
   * and drop still resolves against the full set and a filtered-out card
   * cannot be silently reordered.
   */
  const matchesQuery = (c: Contact): boolean => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      c.name.toLowerCase().includes(q) ||
      (c.bonzo_email ?? "").toLowerCase().includes(q) ||
      (c.phone ?? "").replace(/\D/g, "").includes(q.replace(/\D/g, "")) ||
      (c.notes ?? "").toLowerCase().includes(q)
    );
  };

  const matchesFilter = (c: Contact): boolean => {
    const m = initialMeta[c.id];
    switch (filter) {
      case "excluded":
        return isQueueEligible(c.stage) && !c.insights_enabled;
      case "in_market":
        return m?.leadTemp === "in_market" || m?.leadTemp === "warming";
      case "blocked":
        return m?.leadTemp === "blocked" || m?.leadTemp === "stalled";
      case "untouched":
        return !m?.lastTouchAt;
      default:
        return true;
    }
  };

  const contactsByStage = (stage: AllStages) =>
    contacts
      .filter((c) => c.stage === stage && matchesQuery(c) && matchesFilter(c))
      .sort((a, b) => a.position - b.position);

  const filteredCount = contacts.filter(
    (c) => matchesQuery(c) && matchesFilter(c)
  ).length;

  /**
   * Commits a lead to Adverse with its reason.
   *
   * Reason and stage move together: an adverse lead without a reason is a hole
   * in the funnel record, and the detail form already required one.
   */
  async function confirmAdverse(contact: Contact, reason: AdverseReason) {
    setAdverseFor(null);

    const previous = { stage: contact.stage, position: contact.position };
    setContacts((prev) =>
      prev.map((c) =>
        c.id === contact.id
          ? { ...c, stage: "adverse" as AllStages, adverse_reason: reason }
          : c
      )
    );

    const { error } = await supabase
      .from("contacts")
      .update({ stage: "adverse", adverse_reason: reason })
      .eq("id", contact.id);

    if (error) {
      setContacts((prev) =>
        prev.map((c) => (c.id === contact.id ? { ...c, ...previous } : c))
      );
      toast.error("Could not move that lead to Adverse");
    } else {
      toast.success(`${contact.name} moved to Adverse`, {
        description: ADVERSE_REASON_LABELS[reason],
      });
    }
  }

  /** 4.7 — one-click enrollment for a hot lead the queue cannot see. */
  async function handleEnroll(contactId: string) {
    const contact = contacts.find((c) => c.id === contactId);
    if (!contact) return;

    if (!contact.bonzo_email) {
      toast.error("No Bonzo email on this lead", {
        description: "Open it and connect a Bonzo prospect first.",
      });
      router.push(`/contacts/${contactId}`);
      return;
    }

    // Optimistic: the badge disappearing immediately is the whole point of a
    // one-click control.
    setContacts((prev) =>
      prev.map((c) => (c.id === contactId ? { ...c, insights_enabled: true } : c))
    );

    const { error } = await supabase
      .from("contacts")
      .update({ insights_enabled: true })
      .eq("id", contactId);

    if (error) {
      setContacts((prev) =>
        prev.map((c) => (c.id === contactId ? { ...c, insights_enabled: false } : c))
      );
      toast.error("Could not enroll that lead");
    } else {
      toast.success(`${contact.name} is now in the queue`);
    }
  }

  function handleDragStart(event: DragStartEvent) {
    const contact = contacts.find((c) => c.id === event.active.id);
    if (contact) setActiveContact(contact);
  }

  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over || !activeContact) return;

    const overId = over.id as string;
    const isStageColumn = PIPELINE_STAGES.includes(overId as PipelineStage);
    const newStage = isStageColumn
      ? (overId as PipelineStage)
      : contacts.find((c) => c.id === overId)?.stage;

    if (newStage && newStage !== activeContact.stage) {
      setContacts((prev) =>
        prev.map((c) =>
          c.id === active.id ? { ...c, stage: newStage } : c
        )
      );
      setActiveContact((prev) => (prev ? { ...prev, stage: newStage } : null));
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveContact(null);

    if (!over) return;

    const contactId = active.id as string;
    const contact = contacts.find((c) => c.id === contactId);
    if (!contact) return;

    const overId = over.id as string;
    const isStageColumn = ALL_STAGES.includes(overId as AllStages);
    const targetStage: AllStages = isStageColumn
      ? (overId as AllStages)
      : contacts.find((c) => c.id === overId)?.stage ?? contact.stage;

    // 4.6 — dropping onto Adverse asks for the reason inline rather than
    // sending you to the detail page for a dropdown and a Save. The move is
    // committed by the picker so a cancel leaves the lead where it was.
    //
    // 6.3 — unreachable from the board today: there is no Adverse column to
    // drop onto. Kept because 'adverse' is still a valid stage and this is the
    // correct behaviour if the column ever returns; the picker it opens is very
    // much alive, driven now by the control on the card.
    if (targetStage === "adverse" && contact.stage !== "adverse") {
      setAdverseFor(contact);
      return;
    }

    const stageContacts = contacts
      .filter((c) => c.stage === targetStage && c.id !== contactId)
      .sort((a, b) => a.position - b.position);

    let newPosition: number;
    if (isStageColumn || stageContacts.length === 0) {
      newPosition = stageContacts.length > 0
        ? stageContacts[stageContacts.length - 1].position + 1000
        : 1000;
    } else {
      const overIndex = stageContacts.findIndex((c) => c.id === overId);
      if (overIndex === 0) {
        newPosition = stageContacts[0].position / 2;
      } else if (overIndex === -1) {
        newPosition = stageContacts[stageContacts.length - 1].position + 1000;
      } else {
        newPosition =
          (stageContacts[overIndex - 1].position +
            stageContacts[overIndex].position) /
          2;
      }
    }

    setContacts((prev) =>
      prev.map((c) =>
        c.id === contactId
          ? { ...c, stage: targetStage, position: newPosition }
          : c
      )
    );

    const { error } = await supabase
      .from("contacts")
      .update({ stage: targetStage, position: newPosition })
      .eq("id", contactId);

    if (error) {
      toast.error("Failed to move contact");
      setContacts(initialContacts);
    }
  }

  async function handleCompleteTask(taskId: string) {
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    setTaskCounts((prev) => {
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return prev;
      const newCounts = { ...prev };
      newCounts[task.contact_id] = Math.max(0, (newCounts[task.contact_id] || 0) - 1);
      return newCounts;
    });

    const { error } = await supabase
      .from("tasks")
      .update({ is_done: true, completed_at: new Date().toISOString() })
      .eq("id", taskId);

    if (error) {
      toast.error("Failed to complete task");
      refreshTasks();
    }
  }

  function handleContactCreated(contact: Contact) {
    setContacts((prev) => [...prev, contact]);
    setShowNewContact(false);
  }

  function handleContactDeleted(id: string) {
    setContacts((prev) => prev.filter((c) => c.id !== id));
    setTasks((prev) => prev.filter((t) => t.contact_id !== id));
  }

  return (
    <>
      <div className="flex items-center gap-3 px-4 md:px-6 py-3 border-b border-border/50 flex-wrap">
        <h1 className="text-sm font-medium text-muted-foreground shrink-0">Pipeline</h1>

        {/* 4.5 — there was no search anywhere in the app. */}
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email, phone, notes"
            className="w-full h-8 pl-8 pr-7 rounded-md border border-border/60 bg-transparent text-xs outline-none focus:border-border"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1 flex-wrap">
          {(Object.keys(FILTER_LABELS) as BoardFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2 py-1 rounded-md text-[11px] transition-colors ${
                filter === f
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent"
              }`}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>

        {(search || filter !== "all") && (
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {filteredCount} shown
          </span>
        )}

        <div className="flex items-center gap-2 ml-auto">
          <button
            onClick={() => router.push("/daily")}
            className="relative text-sm font-medium px-3 py-1.5 rounded-md border border-border hover:bg-accent transition-colors flex items-center gap-1.5"
          >
            <Zap className="h-3.5 w-3.5" />
            Start my day
            {queuePending > 0 && (
              <span className="absolute -top-1.5 -right-1.5 h-4 min-w-4 px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold">
                {queuePending}
              </span>
            )}
          </button>
          <button
            onClick={() => setShowNewContact(true)}
            className="text-sm font-medium px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            + New lead
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-x-auto">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          {/* h-full rather than a calc against the viewport. The old
              calc(100vh-7.5rem) assumed a fixed header height, which the undo
              bar and shortcuts panel can now change — the columns would then
              be sized against a header that is no longer that tall. */}
          <div className="flex gap-4 p-4 md:p-6 h-full min-h-0">
            {PIPELINE_STAGES.map((stage) => (
              <StageColumn
                key={stage}
                stage={stage}
                label={STAGE_LABELS[stage]}
                contacts={contactsByStage(stage)}
                taskCounts={taskCounts}
                meta={initialMeta}
                onContactClick={(id) => router.push(`/contacts/${id}`)}
                onEnroll={handleEnroll}
                onMarkAdverse={setAdverseFor}
              />
            ))}

            {/* 6.3 — the Adverse column is gone. It was a sixth column
                competing for width with the pipeline, and Needs Quote earns
                that space more. Marking a lead dead keeps the two-click cost
                4.6 bought: the control now lives on the card itself
                (ContactCard → onMarkAdverse) and opens the same reason picker
                below. Adverse leads are listed on /adverse. */}
            <TodoColumn
              tasks={tasks}
              onCompleteTask={handleCompleteTask}
              onTaskClick={(contactId) => router.push(`/contacts/${contactId}`)}
            />
          </div>

          <DragOverlay>
            {activeContact ? (
              <ContactCard
                contact={activeContact}
                taskCount={taskCounts[activeContact.id] || 0}
                meta={initialMeta[activeContact.id]}
                isDragging
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      {/* 4.6 — the reason picker for an Adverse drop.
          Marking a lead dead was the slowest interaction in the app: open the
          detail page, change a dropdown, pick a reason, click Save. It is now
          a drag and one click, and cancelling leaves the lead where it was. */}
      {adverseFor && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setAdverseFor(null)}
        >
          <div
            className="w-[320px] rounded-xl border border-border bg-card p-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm font-medium mb-1">
              Move {adverseFor.name} to Adverse
            </p>
            <p className="text-xs text-muted-foreground mb-3">
              Why did this one not work out?
            </p>
            <div className="grid grid-cols-2 gap-1.5">
              {ADVERSE_REASONS.map((reason) => (
                <button
                  key={reason}
                  onClick={() => confirmAdverse(adverseFor, reason)}
                  className="rounded-md border border-border/60 px-2 py-1.5 text-xs hover:bg-accent transition-colors text-left"
                >
                  {ADVERSE_REASON_LABELS[reason]}
                </button>
              ))}
            </div>
            <button
              onClick={() => setAdverseFor(null)}
              className="mt-3 w-full text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {showNewContact && (
        <ContactDialog
          contact={null}
          userId={userId}
          open={showNewContact}
          onOpenChange={setShowNewContact}
          onCreated={handleContactCreated}
          onDeleted={handleContactDeleted}
          onTasksChanged={refreshTasks}
        />
      )}
    </>
  );
}
