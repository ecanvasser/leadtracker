"use client";

import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Contact, PipelineStage } from "@/types/db";
import { SortableContactCard } from "./sortable-contact-card";
import { ScrollArea } from "@/components/ui/scroll-area";

interface StageColumnProps {
  stage: PipelineStage;
  label: string;
  contacts: Contact[];
  taskCounts: Record<string, number>;
  onContactClick: (id: string) => void;
}

export function StageColumn({
  stage,
  label,
  contacts,
  taskCounts,
  onContactClick,
}: StageColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });

  return (
    <div
      className={`flex flex-col min-w-[260px] w-[260px] md:flex-1 rounded-xl border border-border/50 bg-muted/30 transition-colors ${
        isOver ? "bg-accent/50 border-accent" : ""
      }`}
    >
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/50">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {contacts.length}
        </span>
      </div>
      <ScrollArea className="flex-1">
        <div ref={setNodeRef} className="p-2 space-y-2 min-h-[60px]">
          <SortableContext
            items={contacts.map((c) => c.id)}
            strategy={verticalListSortingStrategy}
          >
            {contacts.map((contact) => (
              <SortableContactCard
                key={contact.id}
                contact={contact}
                taskCount={taskCounts[contact.id] || 0}
                onClick={() => onContactClick(contact.id)}
              />
            ))}
          </SortableContext>
        </div>
      </ScrollArea>
    </div>
  );
}
