"use client";

import { Contact, LOAN_TYPE_LABELS } from "@/types/db";
import { Badge } from "@/components/ui/badge";
import { ListTodo, EyeOff, Plus } from "lucide-react";
import type { BoardMeta } from "@/app/(app)/board/page";

interface ContactCardProps {
  contact: Contact;
  taskCount: number;
  meta?: BoardMeta;
  onClick?: () => void;
  onEnroll?: (contactId: string) => void;
  isDragging?: boolean;
}

/** Temperature badges. Colour carries the urgency; the label carries the fact. */
const TEMP_STYLE: Record<string, { label: string; className: string }> = {
  in_market: { label: "In market", className: "bg-orange-500/15 text-orange-600 dark:text-orange-400" },
  warming: { label: "Warming", className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  stalled: { label: "Stalled", className: "bg-slate-500/15 text-slate-600 dark:text-slate-400" },
  blocked: { label: "Blocked", className: "bg-red-500/15 text-red-600 dark:text-red-400" },
  unresponsive: { label: "Quiet", className: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400" },
};

const BLOCKER_LABEL: Record<string, string> = {
  prior_denial: "prior denial",
  credit: "credit",
  equity: "equity",
  income: "income",
  dti: "DTI",
  property: "property",
  timing: "timing",
  rate_shopping: "rate shopping",
  competitor: "competitor",
  non_responsive: "no response",
};

/** Whole days since an ISO timestamp. */
function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

function ageLabel(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "1d";
  return `${days}d`;
}

export function ContactCard({
  contact,
  taskCount,
  meta,
  onClick,
  onEnroll,
  isDragging,
}: ContactCardProps) {
  const leadAge = daysSince(contact.created_at);
  const temp = meta?.leadTemp ? TEMP_STYLE[meta.leadTemp] : null;
  const blocker = meta?.blocker ? BLOCKER_LABEL[meta.blocker] ?? meta.blocker : null;

  // 4.7 — a hot lead that is not enrolled is invisible to the queue. That is
  // the single most consequential thing that can be silently wrong about a
  // lead, so it is called out rather than merely absent.
  const excluded = contact.stage === "hot_lead" && !contact.insights_enabled;

  // A lead never contacted is different from one contacted long ago; the card
  // should not imply the second when it means the first.
  const touchLabel =
    meta?.lastTouchAt === null || meta?.lastTouchAt === undefined
      ? "never contacted"
      : `touched ${ageLabel(daysSince(meta.lastTouchAt))} ago`;

  return (
    <div
      onClick={onClick}
      className={`rounded-lg border bg-card p-3 cursor-pointer transition-all ${
        excluded ? "border-dashed border-amber-500/50" : "border-border/60 hover:border-border"
      } ${isDragging ? "shadow-lg rotate-2 scale-105" : "shadow-sm"}`}
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <p className="text-sm font-medium leading-tight">{contact.name}</p>
        <span className="text-[10px] text-muted-foreground tabular-nums shrink-0 mt-0.5">
          {ageLabel(leadAge)}
        </span>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap mb-1.5">
        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-normal">
          {LOAN_TYPE_LABELS[contact.loan_type]}
        </Badge>

        {temp && (
          <Badge
            variant="secondary"
            className={`text-[10px] px-1.5 py-0 font-normal border-0 ${temp.className}`}
          >
            {temp.label}
          </Badge>
        )}

        {blocker && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal">
            {blocker}
            {meta?.blockerConfidence === "low" && "?"}
          </Badge>
        )}
      </div>

      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span>{touchLabel}</span>
        {taskCount > 0 && (
          <span className="ml-auto flex items-center gap-1">
            <ListTodo className="h-3 w-3" />
            {taskCount}
          </span>
        )}
      </div>

      {excluded && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onEnroll?.(contact.id);
          }}
          className="mt-2 w-full flex items-center justify-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-700 dark:text-amber-400 hover:bg-amber-500/20 transition-colors"
        >
          <EyeOff className="h-3 w-3" />
          Not in queue
          <Plus className="h-3 w-3 ml-auto" />
        </button>
      )}
    </div>
  );
}
