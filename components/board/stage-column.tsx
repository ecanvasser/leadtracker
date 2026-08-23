"use client";

import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Contact, PipelineStage } from "@/types/db";
import type { BoardMeta } from "@/app/(app)/board/page";
import type { BoardColumn } from "./columns";
import { SortableContactCard } from "./sortable-contact-card";
import { ScrollArea } from "@/components/ui/scroll-area";

interface StageColumnProps {
  column: BoardColumn;
  contacts: Contact[];
  taskCounts: Record<string, number>;
  meta: Record<string, BoardMeta>;
  onContactClick: (id: string) => void;
  onEnroll?: (contactId: string) => void;
  /** Opens the adverse reason picker for a card. */
  onMarkAdverse?: (contact: Contact) => void;
  /** Sets a card's specific stage from its badge, in a merged column. */
  onChangeStage?: (contact: Contact, stage: PipelineStage) => void;
}

/**
 * One board column.
 *
 * The collapse mechanic is gone (Phase 8 section 3). It existed to fit six
 * columns on a 1440px laptop by folding three of them to a 48px rail, which
 * worked arithmetically and meant the board looked different on first load
 * than it had the day before, with nothing on screen explaining why. Four
 * columns fit natively, so the fix is no longer needed and the ~60 lines of
 * rail rendering, localStorage persistence and toggle state go with it.
 */
export function StageColumn({
  column,
  contacts,
  taskCounts,
  meta,
  onContactClick,
  onEnroll,
  onMarkAdverse,
  onChangeStage,
}: StageColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  // A card only wears its stage where the column does not already say it.
  const merged = column.stages.length > 1;

  return (
    <div
      // overflow-hidden so cards are clipped by the rounded border instead of
      // painting over it, and min-h-0 further down so the list scrolls rather
      // than growing past the column.
      className={`flex flex-col min-w-[260px] w-[260px] md:flex-1 overflow-hidden rounded-xl border border-border/50 bg-muted/30 transition-colors ${
        isOver ? "bg-destructive/10 border-destructive/40" : ""
      }`}
    >
      <div className="shrink-0 flex items-center justify-between gap-2 px-3 py-2.5 border-b border-border/50">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground truncate">
          {column.label}
        </h2>
        <span className="text-xs text-muted-foreground tabular-nums shrink-0">
          {contacts.length}
        </span>
      </div>
      {/* min-h-0 is load-bearing: a flex item defaults to min-height:auto,
          so without it this grows to fit its content and the cards spill out
          of the column instead of scrolling inside it. */}
      <ScrollArea className="flex-1 min-h-0">
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
                onMarkAdverse={onMarkAdverse}
                stageOptions={merged ? column.stages : undefined}
                onChangeStage={onChangeStage}
              />
            ))}
          </SortableContext>
        </div>
      </ScrollArea>
    </div>
  );
}
