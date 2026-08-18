"use client";

import { Contact, LOAN_TYPE_LABELS, CRM_LABELS } from "@/types/db";
import { Badge } from "@/components/ui/badge";
import { ListTodo } from "lucide-react";

interface ContactCardProps {
  contact: Contact;
  taskCount: number;
  onClick?: () => void;
  isDragging?: boolean;
}

export function ContactCard({
  contact,
  taskCount,
  onClick,
  isDragging,
}: ContactCardProps) {
  return (
    <div
      onClick={onClick}
      className={`rounded-lg border border-border/60 bg-card p-3 cursor-pointer hover:border-border transition-all ${
        isDragging ? "shadow-lg rotate-2 scale-105" : "shadow-sm"
      }`}
    >
      <p className="text-sm font-medium leading-tight mb-2">{contact.name}</p>
      <div className="flex items-center gap-1.5 flex-wrap">
        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-normal">
          {LOAN_TYPE_LABELS[contact.loan_type]}
        </Badge>
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal">
          {CRM_LABELS[contact.crm]}
        </Badge>
        {taskCount > 0 && (
          <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
            <ListTodo className="h-3 w-3" />
            {taskCount}
          </span>
        )}
      </div>
    </div>
  );
}
