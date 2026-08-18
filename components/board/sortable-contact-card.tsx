"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Contact } from "@/types/db";
import { ContactCard } from "./contact-card";

interface SortableContactCardProps {
  contact: Contact;
  taskCount: number;
  onClick: () => void;
}

export function SortableContactCard({
  contact,
  taskCount,
  onClick,
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
        onClick={onClick}
      />
    </div>
  );
}
