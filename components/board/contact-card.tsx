"use client";

import { useRef, useState } from "react";
import { Contact, LOAN_TYPE_LABELS, isQueueEligible } from "@/types/db";
import { Badge } from "@/components/ui/badge";
// One badge map for the board card and the Today row — the same fact must not
// be orange in one place and grey in another.
import { PITCH_STYLE } from "@/lib/turn/badges";
import { ListTodo, EyeOff, Plus, Ban } from "lucide-react";
import type { BoardMeta } from "@/app/(app)/board/page";

interface ContactCardProps {
  contact: Contact;
  taskCount: number;
  meta?: BoardMeta;
  onClick?: () => void;
  onEnroll?: (contactId: string) => void;
  /** Opens the adverse reason picker. Omitted on the drag overlay. */
  onMarkAdverse?: (contact: Contact) => void;
  isDragging?: boolean;
}



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
  onMarkAdverse,
  isDragging,
}: ContactCardProps) {
  // 6.3 — the Adverse column is gone, so marking a lead dead lives here. Hover
  // reveals the control on a pointer; a long press reveals it on touch, where
  // there is no hover. Revealing rather than firing on the press itself: this
  // is destructive and irreversible-ish, and an accidental long press while
  // scrolling a column must not kill a lead.
  const [revealed, setRevealed] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPress = () => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  const leadAge = daysSince(contact.created_at);
  const pitch = meta?.pitchResponse ? PITCH_STYLE[meta.pitchResponse] : null;
  // Days since the pitch, when known. Null stays absent rather than rendering
  // as 0 — "0 days" on a lead going cold is worse than no number at all.
  const sincePitch =
    meta?.daysSincePitch !== null && meta?.daysSincePitch !== undefined
      ? `${meta.daysSincePitch}d`
      : null;

  // 4.7 — a lead in a queue-eligible stage that is not enrolled is invisible to
  // the queue. That is the single most consequential thing that can be silently
  // wrong about a lead, so it is called out rather than merely absent. Stages
  // outside QUEUE_ELIGIBLE_STAGES are not "excluded" — they are not worked at
  // all, which is a different thing and not a warning.
  const excluded = isQueueEligible(contact.stage) && !contact.insights_enabled;

  const canMarkAdverse =
    !!onMarkAdverse && !isDragging && contact.stage !== "adverse";

  // A lead never contacted is different from one contacted long ago; the card
  // should not imply the second when it means the first.
  const touchLabel =
    meta?.lastTouchAt === null || meta?.lastTouchAt === undefined
      ? "never contacted"
      : `touched ${ageLabel(daysSince(meta.lastTouchAt))} ago`;

  return (
    <div
      onClick={onClick}
      onTouchStart={() => {
        if (!canMarkAdverse) return;
        cancelPress();
        pressTimer.current = setTimeout(() => setRevealed(true), 500);
      }}
      onTouchMove={cancelPress}
      onTouchEnd={cancelPress}
      onTouchCancel={cancelPress}
      onMouseLeave={() => setRevealed(false)}
      className={`group rounded-lg border bg-card p-3 cursor-pointer transition-all ${
        excluded ? "border-dashed border-amber-500/50" : "border-border/60 hover:border-border"
      } ${isDragging ? "shadow-lg rotate-2 scale-105" : "shadow-sm"}`}
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <p className="text-sm font-medium leading-tight">{contact.name}</p>
        <div className="flex items-center gap-1 shrink-0 mt-0.5">
          {canMarkAdverse && (
            <button
              type="button"
              aria-label={`Mark ${contact.name} adverse`}
              title="Mark adverse"
              // The drag listeners sit on the wrapper. The pointer sensor has an
              // 8px activation distance so a click alone will not start a drag,
              // but the press must still not reach the card's own onClick.
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                cancelPress();
                setRevealed(false);
                onMarkAdverse?.(contact);
              }}
              className={`rounded p-0.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                revealed ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              }`}
            >
              <Ban className="h-3 w-3" />
            </button>
          )}
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {ageLabel(leadAge)}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap mb-1.5">
        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-normal">
          {LOAN_TYPE_LABELS[contact.loan_type]}
        </Badge>

        {pitch && (
          <Badge
            variant="secondary"
            className={`text-[10px] px-1.5 py-0 font-normal border-0 ${pitch.className}`}
          >
            {pitch.label}
            {meta?.evidenceConfidence === "low" && "?"}
          </Badge>
        )}

        {sincePitch && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal">
            {sincePitch}
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
