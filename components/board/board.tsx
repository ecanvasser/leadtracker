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
  STAGE_LABELS,
} from "@/types/db";
import { StageColumn } from "./stage-column";
import { TodoColumn } from "./todo-column";
import { ContactCard } from "./contact-card";
import { ContactDialog } from "@/components/contact/contact-dialog";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { Zap } from "lucide-react";

interface BoardProps {
  initialContacts: Contact[];
  initialTasks: TaskWithContact[];
  initialTaskCounts: Record<string, number>;
  userId: string;
}

export function Board({
  initialContacts,
  initialTasks,
  initialTaskCounts,
  userId,
}: BoardProps) {
  const [contacts, setContacts] = useState<Contact[]>(initialContacts);
  const [tasks, setTasks] = useState<TaskWithContact[]>(initialTasks);
  const [taskCounts, setTaskCounts] = useState(initialTaskCounts);
  const [activeContact, setActiveContact] = useState<Contact | null>(null);
  const [showNewContact, setShowNewContact] = useState(false);
  const [queuePending, setQueuePending] = useState(0);
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

  const contactsByStage = (stage: PipelineStage) =>
    contacts
      .filter((c) => c.stage === stage)
      .sort((a, b) => a.position - b.position);

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
    const isStageColumn = PIPELINE_STAGES.includes(overId as PipelineStage);
    const targetStage = isStageColumn
      ? (overId as PipelineStage)
      : contacts.find((c) => c.id === overId)?.stage ?? contact.stage;

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
      <div className="flex items-center justify-between px-4 md:px-6 py-3 border-b border-border/50">
        <h1 className="text-sm font-medium text-muted-foreground">Pipeline</h1>
        <div className="flex items-center gap-2">
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

      <div className="flex-1 overflow-x-auto">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          <div className="flex gap-4 p-4 md:p-6 min-h-0 h-[calc(100vh-7.5rem)]">
            {PIPELINE_STAGES.map((stage) => (
              <StageColumn
                key={stage}
                stage={stage}
                label={STAGE_LABELS[stage]}
                contacts={contactsByStage(stage)}
                taskCounts={taskCounts}
                onContactClick={(id) => router.push(`/contacts/${id}`)}
              />
            ))}
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
                isDragging
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      {showNewContact && (
        <ContactDialog
          contact={null}
          userId={userId}
          open={showNewContact}
          onOpenChange={setShowNewContact}
          onCreated={handleContactCreated}
          onTasksChanged={refreshTasks}
        />
      )}
    </>
  );
}
