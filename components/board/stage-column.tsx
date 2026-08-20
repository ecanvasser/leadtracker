"use client";

import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Contact, AllStages } from "@/types/db";
import type { BoardMeta } from "@/app/(app)/board/page";
import { SortableContactCard } from "./sortable-contact-card";
import { ScrollArea } from "@/components/ui/scroll-area";

interface StageColumnProps {
  /** Includes 'adverse', which is a drop target like any other stage. */
  stage: AllStages;
  label: string;
  contacts: Contact[];
  taskCounts: Record<string, number>;
  meta: Record<string, BoardMeta>;
  /** Renders the column de-emphasised — used for Adverse. */
  muted?: boolean;
  onContactClick: (id: string) => void;
  onEnroll?: (contactId: string) => void;
}

export function StageColumn({
  stage,
  label,
  contacts,
  taskCounts,
  meta,
  muted,
  onContactClick,
  onEnroll,
}: StageColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });

  return (
    <div
      className={`flex flex-col min-w-[260px] w-[260px] md:flex-1 rounded-xl border transition-colors ${
        muted ? "border-border/30 bg-muted/10" : "border-border/50 bg-muted/30"
      } ${isOver ? "bg-destructive/10 border-destructive/40" : ""}`}
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
                meta={meta[contact.id]}
                onClick={() => onContactClick(contact.id)}
                onEnroll={onEnroll}
              />
            ))}
          </SortableContext>
        </div>
      </ScrollArea>
    </div>
  );
}
