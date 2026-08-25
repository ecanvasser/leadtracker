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
  STAGE_LABELS,
  ADVERSE_REASONS,
  ADVERSE_REASON_LABELS,
  isQueueEligible,
  type AdverseReason,
} from "@/types/db";
import type { BoardMeta } from "@/app/(app)/board/page";
import { BOARD_COLUMNS, columnById, columnForStage, stageForDrop } from "./columns";
import { StageColumn } from "./stage-column";
import { TodoColumn } from "./todo-column";
import { ContactCard } from "./contact-card";
import { ContactDialog } from "@/components/contact/contact-dialog";
import { DeployAgentDialog } from "@/components/agents/deploy-agent-dialog";
import Link from "next/link";
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

/**
 * Board filters. "excluded" surfaces hot leads the queue cannot see.
 *
 * Phase 8 section 3 adds the whose-turn axis, which is now the primary one:
 * the board's other filters describe what a lead *is*, and these two describe
 * whether Eddie has to do anything about it. They read the same verdict the
 * Today screen renders, computed by the same function.
 */
type BoardFilter =
  | "all"
  | "yours"
  | "overdue"
  | "excluded"
  | "quiet"
  | "interested"
  | "untouched";

const FILTER_LABELS: Record<BoardFilter, string> = {
  all: "All",
  yours: "Your move",
  overdue: "Overdue",
  excluded: "Not in queue",
  interested: "Interested",
  quiet: "Gone quiet",
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
  const [deployAgentFor, setDeployAgentFor] = useState<Contact | null>(null);
  const [agentContactIds, setAgentContactIds] = useState<Set<string>>(new Set());
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
      // The whose-turn axis. `turn` is the verdict from lib/turn/, computed
      // server-side by the same function the Today screen uses, so a lead the
      // board calls "your move" is the same lead Today counts.
      case "yours":
        return m?.turn === "your_move";
      case "overdue":
        return m?.turn === "their_move";
      case "excluded":
        return isQueueEligible(c.stage) && !c.insights_enabled;
      // Phase 7: filters read the post-pitch taxonomy. "Interested" is the
      // lead who reacted well to the number; "quiet" is the one who did not
      // react at all, which is the population the 2-day handoff rule targets.
      case "interested":
        return (
          m?.pitchResponse === "positive_intent" ||
          m?.pitchResponse === "converted_signal"
        );
      case "quiet":
        return m?.pitchResponse === "no_response" || m?.pitchResponse === "soft_no";
      case "untouched":
        return !m?.lastTouchAt;
      default:
        return true;
    }
  };

  const contactsInColumn = (columnId: string) =>
    contacts
      .filter(
        (c) =>
          columnForStage(c.stage)?.id === columnId &&
          matchesQuery(c) &&
          matchesFilter(c)
      )
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

  /**
   * D2: sets the specific stage from a card's badge in the merged column.
   *
   * The same write a drag makes, so the same database trigger records it to
   * stage_transitions. Nothing about the history depends on which control the
   * change came from.
   */
  async function handleChangeStage(contact: Contact, stage: PipelineStage) {
    const previous = contact.stage;
    setContacts((prev) =>
      prev.map((c) => (c.id === contact.id ? { ...c, stage } : c))
    );

    const { error } = await supabase
      .from("contacts")
      .update({ stage })
      .eq("id", contact.id);

    if (error) {
      setContacts((prev) =>
        prev.map((c) => (c.id === contact.id ? { ...c, stage: previous } : c))
      );
      toast.error("Could not change that stage");
      return;
    }

    toast.success(`${contact.name} → ${STAGE_LABELS[stage]}`);
  }

  /*
   * Which leads already have a running agent.
   *
   * One query for the board rather than one per card: the badge is on every
   * card, and a fetch per card would be forty requests on first paint.
   */
  const loadAgents = useCallback(async () => {
    const { data } = await supabase
      .from("contact_agents")
      .select("contact_id")
      .in("status", ["draft", "active", "paused"]);
    setAgentContactIds(new Set((data ?? []).map((r) => r.contact_id as string)));
  }, [supabase]);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  function handleDragStart(event: DragStartEvent) {
    const contact = contacts.find((c) => c.id === event.active.id);
    if (contact) setActiveContact(contact);
  }

  /**
   * Resolves what was dropped on into a column.
   *
   * A drop lands either on a column's own droppable id or on a card inside
   * one, and since D2 those are no longer the same thing as a stage — the id
   * is `col_in_process` while the card in it might be App In, Submission or
   * Processing. Both cases funnel through here so the two drag handlers
   * cannot disagree about where a card went.
   */
  function resolveDrop(overId: string) {
    const asColumn = columnById(overId);
    if (asColumn) return { column: asColumn, droppedOnColumn: true };

    const overStage = contacts.find((c) => c.id === overId)?.stage;
    return {
      column: overStage ? columnForStage(overStage) : undefined,
      droppedOnColumn: false,
    };
  }

  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over || !activeContact) return;

    const { column } = resolveDrop(over.id as string);
    if (!column) return;

    const newStage = stageForDrop(column, activeContact.stage);

    if (newStage !== activeContact.stage) {
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
    const { column, droppedOnColumn } = resolveDrop(overId);
    if (!column) return;

    /*
     * D2: dropping into the merged column assigns App In, but only when the
     * card is arriving from somewhere else. A Processing card nudged up two
     * places inside its own column is a reorder, not a demotion — stageForDrop
     * keeps the current stage whenever the column already holds it.
     *
     * The Adverse branch that used to live here is gone with the column model.
     * It was already documented as unreachable — there has been no Adverse
     * column to drop onto since 6.3 — and now a drop target is either a
     * `col_*` id or a card in one of the four columns, none of which can be
     * adverse. Marking a lead dead is the control on the card, which is very
     * much alive.
     */
    const targetStage: AllStages = stageForDrop(column, contact.stage);

    /*
     * Position is ordered within the *column*, not within the stage. The
     * merged column interleaves three stages in one list, so ordering per
     * stage would make a card jump on drop to wherever its own stage's run
     * happened to be.
     */
    const columnContacts = contacts
      .filter((c) => columnForStage(c.stage)?.id === column.id && c.id !== contactId)
      .sort((a, b) => a.position - b.position);

    let newPosition: number;
    if (droppedOnColumn || columnContacts.length === 0) {
      newPosition = columnContacts.length > 0
        ? columnContacts[columnContacts.length - 1].position + 1000
        : 1000;
    } else {
      const overIndex = columnContacts.findIndex((c) => c.id === overId);
      if (overIndex === 0) {
        newPosition = columnContacts[0].position / 2;
      } else if (overIndex === -1) {
        newPosition = columnContacts[columnContacts.length - 1].position + 1000;
      } else {
        newPosition =
          (columnContacts[overIndex - 1].position +
            columnContacts[overIndex].position) /
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
          {/*
            Phase 8 section 5: Adverse and Funded came off the top-level nav.
            They are terminal lists — places a lead ends up, not places Eddie
            works — and the board is where a lead was sent to one of them, so
            it is where you would go looking. Kept as plain links rather than
            buttons: they are destinations, not actions.
          */}
          <Link
            href="/adverse"
            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            Adverse
          </Link>
          <Link
            href="/funded"
            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            Funded
          </Link>
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
            {BOARD_COLUMNS.map((column) => (
              <StageColumn
                key={column.id}
                column={column}
                contacts={contactsInColumn(column.id)}
                taskCounts={taskCounts}
                meta={initialMeta}
                onContactClick={(id) => router.push(`/contacts/${id}`)}
                onEnroll={handleEnroll}
                onMarkAdverse={setAdverseFor}
                onDeployAgent={setDeployAgentFor}
                agentContactIds={agentContactIds}
                onChangeStage={handleChangeStage}
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
      {deployAgentFor && (
        <DeployAgentDialog
          contactId={deployAgentFor.id}
          contactName={deployAgentFor.name}
          open
          onClose={() => setDeployAgentFor(null)}
          onChanged={loadAgents}
        />
      )}

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
