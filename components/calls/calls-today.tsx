"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Phone, Check, X, Clock } from "lucide-react";
import type { DayCall, WantsCall } from "@/lib/calls/book";

/**
 * The day's calls, above everything else on Today.
 *
 * A call is the only item in this app with a deadline someone else is holding
 * you to. Everything below it — quotes owed, leads gone quiet — can slip an
 * hour without anyone noticing; a call at noon cannot. So it sits above the
 * counts rather than inside them, and it renders even when empty is false.
 *
 * Deliberately not merged into the whose-turn model. A booked call already
 * makes a lead `waiting` with "Call booked Thursday 2pm" as its reason, which
 * is the right answer to "should I chase them". This answers a different
 * question: what am I doing today, and at what time.
 */
export function CallsToday({
  initialCalls,
  initialOverdue,
  initialWantsCall,
  timeZone,
}: {
  initialCalls: DayCall[];
  initialOverdue: DayCall[];
  initialWantsCall: WantsCall[];
  timeZone: string;
}) {
  const [calls, setCalls] = useState(initialCalls);
  const [overdue, setOverdue] = useState(initialOverdue);
  const [wants, setWants] = useState(initialWantsCall);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/calls");
      const body = await res.json();
      setCalls(body.calls ?? []);
      setOverdue(body.overdue ?? []);
      setWants(body.wantsCall ?? []);
    } catch {
      // The server-rendered list stands.
    }
  }, []);

  useEffect(() => {
    setCalls(initialCalls);
    setOverdue(initialOverdue);
    setWants(initialWantsCall);
  }, [initialCalls, initialOverdue, initialWantsCall]);

  async function act(callId: string, action: string) {
    setBusy(callId);
    const res = await fetch(`/api/calls/${callId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setBusy(null);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      toast.error(b.error ?? "Could not update that call");
      return;
    }
    await reload();
  }

  async function dismissWants(contactId: string) {
    setBusy(contactId);
    await fetch("/api/calls/wants", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contactId }),
    });
    setBusy(null);
    await reload();
  }

  if (calls.length === 0 && overdue.length === 0 && wants.length === 0) return null;

  return (
    <div className="mb-6 rounded-xl border border-border/60 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Phone className="h-4 w-4" />
        <h2 className="text-sm font-semibold">
          Calls today
          {calls.length > 0 && (
            <span className="ml-2 text-muted-foreground tabular-nums">
              {calls.length}
            </span>
          )}
        </h2>
      </div>

      {calls.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing booked for today.</p>
      ) : (
        <ol className="space-y-2">
          {calls.map((c) => (
            <CallRow
              key={c.id}
              call={c}
              timeZone={timeZone}
              busy={busy === c.id}
              onAct={act}
            />
          ))}
        </ol>
      )}

      {wants.length > 0 && (
        <div className="mt-4 border-t border-border/60 pt-3">
          {/*
            The gap the time-extracting detector cannot see. "Let's talk in the
            morning — what time are you available?" has no time to extract, so
            before this it produced silence, indistinguishable from a thread
            with no call in it. It is the worst case to be quiet about: the
            lead asked, and is waiting.
          */}
          <p className="mb-2 text-[11px] font-medium text-sky-400">
            Asked to talk — no time set
          </p>
          <ol className="space-y-2">
            {wants.map((w) => (
              <li key={w.contact_id} className="flex items-start gap-3 text-sm">
                <span className="w-16 shrink-0 pt-0.5 text-xs text-muted-foreground">
                  {new Intl.DateTimeFormat("en-US", {
                    timeZone,
                    month: "short",
                    day: "numeric",
                  }).format(new Date(w.asked_at))}
                </span>
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/contacts/${w.contact_id}`}
                    className="font-medium hover:underline"
                  >
                    {w.contact_name}
                  </Link>
                  <p className="mt-0.5 text-xs italic text-muted-foreground">
                    “{w.quote}”
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Link
                    href={`/contacts/${w.contact_id}`}
                    className="rounded border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-border hover:text-foreground"
                  >
                    Book
                  </Link>
                  <button
                    type="button"
                    disabled={busy === w.contact_id}
                    onClick={() => dismissWants(w.contact_id)}
                    title="Dismiss"
                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {overdue.length > 0 && (
        <div className="mt-4 border-t border-border/60 pt-3">
          {/*
            A call whose time has passed does not disappear at midnight. If it
            vanished, the list would look tidy while the person who agreed to
            the call is still waiting to hear from someone.
          */}
          <p className="mb-2 text-[11px] font-medium text-amber-500">
            Went by without an outcome
          </p>
          <ol className="space-y-2">
            {overdue.map((c) => (
              <CallRow
                key={c.id}
                call={c}
                timeZone={timeZone}
                busy={busy === c.id}
                onAct={act}
                overdue
              />
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function CallRow({
  call,
  timeZone,
  busy,
  onAct,
  overdue,
}: {
  call: DayCall;
  timeZone: string;
  busy: boolean;
  onAct: (id: string, action: string) => void;
  overdue?: boolean;
}) {
  const at = new Date(call.scheduled_at);

  const mine = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(at);

  const theirs = new Intl.DateTimeFormat("en-US", {
    timeZone: call.prospect_timezone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(at);

  // Only worth saying when the two differ — otherwise it is noise on every row.
  const differentZone = call.prospect_timezone !== timeZone;

  return (
    <li className="flex items-start gap-3 text-sm">
      <span className="w-16 shrink-0 pt-0.5 font-medium tabular-nums">{mine}</span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            href={`/contacts/${call.contact_id}`}
            className="font-medium hover:underline"
          >
            {call.contact_name}
          </Link>
          {call.phone && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {call.phone}
            </span>
          )}
          {differentZone && (
            <span className="text-[11px] text-muted-foreground">
              {theirs} their time
            </span>
          )}
          {call.status === "proposed" && (
            // Unconfirmed is the more urgent state, not the calmer one: it is
            // waiting on Eddie to say whether the reading was right.
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-500">
              needs confirming
            </span>
          )}
        </div>

        {(call.note || call.source_quote) && (
          <p className="mt-0.5 text-xs italic text-muted-foreground">
            {call.note ?? `“${call.source_quote}”`}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {call.status === "proposed" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onAct(call.id, "confirm")}
            title="Confirm this call"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
        )}
        {overdue && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onAct(call.id, "completed")}
            title="I made this call"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-emerald-500"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
        )}
        {overdue && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onAct(call.id, "missed")}
            title="Missed it"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-amber-500"
          >
            <Clock className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => onAct(call.id, "cancel")}
          title="Cancel"
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </li>
  );
}
