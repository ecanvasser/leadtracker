"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Contact, type PipelineStage } from "@/types/db";
import type { BoardMeta } from "@/app/(app)/board/page";
import { ContactCard } from "./contact-card";

interface SortableContactCardProps {
  contact: Contact;
  taskCount: number;
  meta?: BoardMeta;
  onClick: () => void;
  onEnroll?: (contactId: string) => void;
  onMarkAdverse?: (contact: Contact) => void;
  stageOptions?: readonly PipelineStage[];
  onChangeStage?: (contact: Contact, stage: PipelineStage) => void;
}

export function SortableContactCard({
  contact,
  taskCount,
  meta,
  onClick,
  onEnroll,
  onMarkAdverse,
  stageOptions,
  onChangeStage,
}: SortableContactCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: contact.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <ContactCard
        contact={contact}
        taskCount={taskCount}
        meta={meta}
        onClick={onClick}
        onEnroll={onEnroll}
        onMarkAdverse={onMarkAdverse}
        stageOptions={stageOptions}
        onChangeStage={onChangeStage}
      />
    </div>
  );
}
