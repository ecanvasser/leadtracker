"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronRight,
  Check,
  Clock,
  ExternalLink,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PITCH_STYLE } from "@/lib/turn/badges";
import { describeWait } from "@/lib/turn/format";
import { bonzoProspectUrl } from "@/lib/turn/links";
import type { TurnResult } from "@/lib/turn/types";
import {
  LOAN_TYPE_LABELS,
  PIPELINE_STAGES,
  STAGE_LABELS,
  type AllStages,
} from "@/types/db";

interface TodayScreenProps {
  yourMove: TurnResult[];
  theirMove: TurnResult[];
  waiting: TurnResult[];
  counts: { your_move: number; their_move: number; waiting: number; total: number };
  timeZone: string;
  overdueDays: number;
}

const SNOOZE_OPTIONS = [
  { label: "Tomorrow", days: 1 },
  { label: "3 days", days: 3 },
  { label: "Next week", days: 7 },
];

export function TodayScreen({
  yourMove,
  theirMove,
  waiting,
  counts,
  timeZone,
  overdueDays,
}: TodayScreenProps) {
  const [waitingOpen, setWaitingOpen] = useState(false);
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // `now` is fixed for the life of the render rather than read per row, so
  // every duration on screen is measured from the same instant. Rows that
  // disagree by a second would be invisible; rows that disagree about which
  // calendar day it is would not.
  const now = useMemo(() => new Date(), []);

  async function act(body: Record<string, unknown>, success: string) {
    const res = await fetch("/api/today/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: "" }));
      toast.error(error || "That didn't go through");
      return;
    }
    toast.success(success);
    startTransition(() => router.refresh());
  }

  const caughtUp = counts.your_move === 0 && counts.their_move === 0;

  /*
   * Section 2.2: the stage badge appears "only when it isn't obvious from the
   * section". Which sections those are is a property of the data, not
   * something to hardcode — Their move turns out to hold App In leads
   * alongside the quoted ones, because a lead who has gone quiet mid-file is
   * just as much a follow-up as one who went quiet after a pitch. So the
   * badge shows wherever a section is not all one stage, and disappears on
   * its own when it is.
   */
  const yourMoveMixed = distinctStages(yourMove) > 1;
  const theirMoveMixed = distinctStages(theirMove) > 1;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-6">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Today</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {counts.total === 0
            ? "No active leads."
            : `${counts.total} active ${counts.total === 1 ? "lead" : "leads"}, sorted by how long they've waited.`}
        </p>
      </header>

      {/*
        Section 2.1: the counts at the top are the product. If these three
        numbers are right, nothing else needs opening — so they are the
        largest thing on the page and they are read from the same grouping
        that renders the rows, never counted separately.
      */}
      <div className="mb-8 grid grid-cols-3 gap-3">
        <CountTile
          value={counts.your_move}
          label="Your move"
          tone={counts.your_move > 0 ? "urgent" : "calm"}
        />
        <CountTile
          value={counts.their_move}
          label="Overdue"
          tone={counts.their_move > 0 ? "warn" : "calm"}
        />
        <CountTile value={counts.waiting} label="Waiting" tone="calm" />
      </div>

      <Section
        title="Your move"
        count={counts.your_move}
        blurb="Quotes owed, questions unanswered"
        empty={
          // Section 2.5: an empty Your move is a win, not a blank panel.
          <EmptyState
            headline="Nothing owed."
            detail="No quotes outstanding and no unanswered questions."
          />
        }
      >
        {yourMove.map((row) => (
          <Row
            key={row.contact.id}
            row={row}
            now={now}
            timeZone={timeZone}
            showStage={yourMoveMixed}
            onAct={act}
            busy={pending}
          />
        ))}
      </Section>

      <Section
        title="Their move, overdue"
        count={counts.their_move}
        blurb={`No reply for ${overdueDays} ${overdueDays === 1 ? "day" : "days"} or more`}
        empty={
          <EmptyState
            headline="Nobody's gone quiet."
            detail={`Everyone you're waiting on has replied or is still inside the ${overdueDays}-day window.`}
          />
        }
      >
        {theirMove.map((row) => (
          <Row
            key={row.contact.id}
            row={row}
            now={now}
            timeZone={timeZone}
            showStage={theirMoveMixed}
            onAct={act}
            busy={pending}
          />
        ))}
      </Section>

      {/* Collapsed by default. Section 2.1 — nothing to do, and why. */}
      <section className="mt-8">
        <button
          type="button"
          onClick={() => setWaitingOpen((v) => !v)}
          className="flex w-full items-baseline gap-2 border-b border-border/50 pb-2 text-left"
          aria-expanded={waitingOpen}
        >
          {waitingOpen ? (
            <ChevronDown className="size-4 self-center text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 self-center text-muted-foreground" />
          )}
          <h2 className="text-sm font-semibold tracking-tight">Waiting</h2>
          <span className="text-sm tabular-nums text-muted-foreground">({counts.waiting})</span>
          <span className="ml-auto text-xs text-muted-foreground">Nothing to do, and why</span>
        </button>

        {waitingOpen && (
          <div className="divide-y divide-border/50">
            {counts.waiting === 0 ? (
              <p className="py-6 text-sm text-muted-foreground">
                Nothing parked. Every active lead is in one of the two sections above.
              </p>
            ) : (
              waiting.map((row) => (
                <WaitingRow key={row.contact.id} row={row} onAct={act} busy={pending} />
              ))
            )}
          </div>
        )}
      </section>

      {caughtUp && counts.total > 0 && (
        <p className="mt-10 text-center text-sm text-muted-foreground">
          You&rsquo;re caught up. The other {counts.waiting}{" "}
          {counts.waiting === 1 ? "lead is" : "leads are"} accounted for above.
        </p>
      )}
    </div>
  );
}

/** How many distinct stages a section holds. */
function distinctStages(rows: TurnResult[]): number {
  return new Set(rows.map((r) => r.contact.stage)).size;
}

function CountTile({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone: "urgent" | "warn" | "calm";
}) {
  const toneClass =
    tone === "urgent"
      ? "text-foreground"
      : tone === "warn"
        ? "text-orange-600 dark:text-orange-400"
        : "text-muted-foreground";

  return (
    <div className="rounded-lg border border-border/60 px-4 py-3">
      <div className={`text-3xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function Section({
  title,
  count,
  blurb,
  empty,
  children,
}: {
  title: string;
  count: number;
  blurb: string;
  empty: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <div className="flex items-baseline gap-2 border-b border-border/50 pb-2">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        <span className="text-sm tabular-nums text-muted-foreground">({count})</span>
        <span className="ml-auto text-xs text-muted-foreground">{blurb}</span>
      </div>
      {count === 0 ? empty : <div className="divide-y divide-border/50">{children}</div>}
    </section>
  );
}

function EmptyState({ headline, detail }: { headline: string; detail: string }) {
  return (
    <div className="py-8 text-center">
      <p className="text-sm font-medium">{headline}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function Row({
  row,
  now,
  timeZone,
  showStage,
  onAct,
  busy,
}: {
  row: TurnResult;
  now: Date;
  timeZone: string;
  showStage: boolean;
  onAct: (body: Record<string, unknown>, success: string) => Promise<void>;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { contact, leadState } = row;

  // Section 2.2: never "0 days". describeWait returns null when the duration
  // is unknown and the element is omitted entirely rather than zeroed.
  const wait = describeWait(row.waiting_since, now, timeZone);
  const pitch = leadState?.pitch_response ? PITCH_STYLE[leadState.pitch_response] : null;
  const angle = leadState?.suggested_angle?.trim() || null;
  const evidence = leadState?.evidence?.trim() || null;

  return (
    <div className="py-2.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={open}
        >
          <span className="truncate text-sm font-medium">{contact.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {LOAN_TYPE_LABELS[contact.loan_type]}
          </span>
          {showStage && (
            <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px] font-normal">
              {STAGE_LABELS[contact.stage]}
            </Badge>
          )}
          {pitch && (
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${pitch.className}`}>
              {pitch.label}
            </span>
          )}
          {wait && (
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{wait}</span>
          )}
        </button>

        <RowActions row={row} onAct={onAct} busy={busy} />
      </div>

      {/* Truncated on the collapsed row; the expanded panel prints it in full,
          so showing both would say the same thing twice. */}
      {angle && !open && (
        <p className="mt-0.5 truncate pr-24 text-xs text-muted-foreground">{angle}</p>
      )}

      {/* Rows expand in place. Opening the contact page is optional (2.3). */}
      {open && (
        <div className="mt-2 space-y-2 rounded-md bg-muted/40 p-3 text-xs">
          {evidence ? (
            <blockquote className="border-l-2 border-border pl-3 italic text-muted-foreground">
              &ldquo;{evidence}&rdquo;
            </blockquote>
          ) : (
            <p className="text-muted-foreground">No quoted evidence on file for this lead.</p>
          )}
          {angle && <p>{angle}</p>}
          <Link
            href={`/contacts/${contact.id}`}
            className="inline-block text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Open contact
          </Link>
        </div>
      )}
    </div>
  );
}

function WaitingRow({
  row,
  onAct,
  busy,
}: {
  row: TurnResult;
  onAct: (body: Record<string, unknown>, success: string) => Promise<void>;
  busy: boolean;
}) {
  const { contact } = row;
  const snoozed = row.reason?.startsWith("Snoozed until");

  return (
    <div className="flex items-center gap-2 py-2">
      <span className="truncate text-sm">{contact.name}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {LOAN_TYPE_LABELS[contact.loan_type]}
      </span>
      {/* Section 1.3: the reason is the whole value of this list. */}
      <span className="ml-auto truncate text-xs text-muted-foreground">{row.reason}</span>
      {snoozed && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 px-2 text-xs"
          disabled={busy}
          onClick={() => onAct({ contactId: contact.id, action: "unsnooze" }, `${contact.name} un-snoozed`)}
        >
          Wake
        </Button>
      )}
    </div>
  );
}

function RowActions({
  row,
  onAct,
  busy,
}: {
  row: TurnResult;
  onAct: (body: Record<string, unknown>, success: string) => Promise<void>;
  busy: boolean;
}) {
  const { contact } = row;

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        title="Done"
        disabled={busy}
        onClick={() => onAct({ contactId: contact.id, action: "done" }, `${contact.name} marked done`)}
      >
        <Check className="size-3.5" />
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost" className="size-7" title="Snooze" disabled={busy}>
            <Clock className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {SNOOZE_OPTIONS.map((opt) => (
            <DropdownMenuItem
              key={opt.days}
              onClick={() =>
                onAct(
                  { contactId: contact.id, action: "snooze", days: opt.days },
                  `${contact.name} snoozed`
                )
              }
            >
              {opt.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy}>
            Stage
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {PIPELINE_STAGES.map((stage) => (
            <DropdownMenuItem
              key={stage}
              disabled={stage === contact.stage}
              onClick={() =>
                onAct(
                  { contactId: contact.id, action: "stage", stage: stage as AllStages },
                  `${contact.name} moved to ${STAGE_LABELS[stage]}`
                )
              }
            >
              {STAGE_LABELS[stage]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {contact.bonzo_prospect_id && (
        <a
          href={bonzoProspectUrl(contact.bonzo_prospect_id)}
          target="_blank"
          rel="noopener noreferrer"
          title="Open in Bonzo"
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ExternalLink className="size-3.5" />
        </a>
      )}
    </div>
  );
}
