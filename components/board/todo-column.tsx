"use client";

import { TaskWithContact, LOAN_TYPE_LABELS } from "@/types/db";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

interface TodoColumnProps {
  tasks: TaskWithContact[];
  onCompleteTask: (taskId: string) => void;
  onTaskClick: (contactId: string) => void;
}

export function TodoColumn({
  tasks,
  onCompleteTask,
  onTaskClick,
}: TodoColumnProps) {
  return (
    <div className="flex flex-col min-w-[260px] w-[260px] md:flex-1 rounded-xl border border-border/50 bg-muted/30">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/50">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          To-Do
        </h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {tasks.length}
        </span>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-2 min-h-[60px]">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              onComplete={() => onCompleteTask(task.id)}
              onClick={() => onTaskClick(task.contact_id)}
            />
          ))}
          {tasks.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-8">
              No open tasks
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function TaskCard({
  task,
  onComplete,
  onClick,
}: {
  task: TaskWithContact;
  onComplete: () => void;
  onClick: () => void;
}) {
  const formatDue = (date: string | null) => {
    if (!date) return null;
    const d = new Date(date + "T00:00:00");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.ceil(
      (d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
    );
    if (diff < 0) return { text: "Overdue", className: "text-red-500" };
    if (diff === 0) return { text: "Today", className: "text-amber-500" };
    if (diff === 1) return { text: "Tomorrow", className: "text-amber-500" };
    return {
      text: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      className: "text-muted-foreground",
    };
  };

  const due = formatDue(task.due_date);

  return (
    <div className="rounded-lg border border-border/60 bg-card p-3 shadow-sm">
      <div className="flex items-start gap-2">
        <Checkbox
          className="mt-0.5 shrink-0"
          onCheckedChange={() => onComplete()}
        />
        <div className="flex-1 min-w-0">
          <p
            className="text-sm leading-tight cursor-pointer hover:underline"
            onClick={onClick}
          >
            {task.title}
          </p>
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            <span className="text-[10px] text-muted-foreground truncate">
              {task.contacts.name}
            </span>
            <Badge
              variant="secondary"
              className="text-[10px] px-1.5 py-0 font-normal"
            >
              {LOAN_TYPE_LABELS[task.contacts.loan_type]}
            </Badge>
            {due && (
              <span className={`ml-auto text-[10px] font-medium ${due.className}`}>
                {due.text}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
