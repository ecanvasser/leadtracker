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
import { ChevronRight } from "lucide-react";

interface StageColumnProps {
  /**
   * Typed as AllStages rather than PipelineStage: 'adverse' is still a valid
   * stage and was rendered as a column until 6.3. The board only mounts
   * pipeline stages now.
   */
  stage: AllStages;
  label: string;
  contacts: Contact[];
  taskCounts: Record<string, number>;
  meta: Record<string, BoardMeta>;
  onContactClick: (id: string) => void;
  onEnroll?: (contactId: string) => void;
  /** Opens the adverse reason picker for a card. */
  onMarkAdverse?: (contact: Contact) => void;
  /**
   * Phase 7: six pipeline stages plus Todo need 1964px at full width, and a
   * 1440px laptop hides two of them behind a horizontal scroll. A collapsed
   * column shrinks to a 48px rail that still shows its name and count — and
   * still accepts a drop, which is why the droppable ref stays mounted in
   * both states rather than being conditionally rendered.
   */
  collapsed?: boolean;
  onToggleCollapse?: (stage: AllStages) => void;
}

export function StageColumn({
  stage,
  label,
  contacts,
  taskCounts,
  meta,
  onContactClick,
  onEnroll,
  onMarkAdverse,
  collapsed = false,
  onToggleCollapse,
}: StageColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });

  if (collapsed) {
    return (
      <div
        ref={setNodeRef}
        className={`flex flex-col shrink-0 w-12 overflow-hidden rounded-xl border border-border/50 bg-muted/30 transition-colors ${
          isOver ? "bg-destructive/10 border-destructive/40" : ""
        }`}
      >
        <button
          type="button"
          onClick={() => onToggleCollapse?.(stage)}
          aria-expanded={false}
          title={`Expand ${label}`}
          className="flex-1 min-h-0 flex flex-col items-center gap-2 py-2.5 hover:bg-accent/40 transition-colors"
        >
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs text-muted-foreground tabular-nums shrink-0">
            {contacts.length}
          </span>
          {/* Rotated rather than letter-stacked: a vertical run of single
              characters is much harder to read at a glance than a turned
              label, and these are two- and three-word stage names. */}
          <span
            className="text-xs font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap"
            style={{ writingMode: "vertical-rl" }}
          >
            {label}
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      // overflow-hidden so cards are clipped by the rounded border instead of
      // painting over it, and min-h-0 further down so the list scrolls rather
      // than growing past the column.
      className={`flex flex-col min-w-[260px] w-[260px] md:flex-1 overflow-hidden rounded-xl border border-border/50 bg-muted/30 transition-colors ${
        isOver ? "bg-destructive/10 border-destructive/40" : ""
      }`}
    >
      <button
        type="button"
        onClick={() => onToggleCollapse?.(stage)}
        aria-expanded
        title={`Collapse ${label}`}
        className="shrink-0 flex items-center justify-between gap-2 px-3 py-2.5 border-b border-border/50 hover:bg-accent/40 transition-colors text-left"
      >
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground truncate">
          {label}
        </h2>
        <span className="flex items-center gap-1.5 shrink-0">
          <span className="text-xs text-muted-foreground tabular-nums">
            {contacts.length}
          </span>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground rotate-180" />
        </span>
      </button>
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
              />
            ))}
          </SortableContext>
        </div>
      </ScrollArea>
    </div>
  );
}
