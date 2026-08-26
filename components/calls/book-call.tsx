"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Phone, X } from "lucide-react";

interface ExistingCall {
  id: string;
  scheduled_at: string;
  status: string;
  source: string;
  source_quote: string | null;
  note: string | null;
  prospect_timezone: string;
}

/**
 * Booking a call on one lead, from the contact page.
 *
 * The detector handles "call me at noon tomorrow" written in Bonzo. This is
 * for the rest: a time agreed on a call, one Eddie decides himself, or a
 * correction to something the scanner read wrong.
 *
 * Shows the existing call rather than hiding behind a button, because the
 * question this panel answers most often is "is a call already booked with
 * this person", not "let me book one".
 */
export function BookCall({
  contactId,
  contactName,
}: {
  contactId: string;
  contactName: string;
}) {
  const [call, setCall] = useState<ExistingCall | null>(null);
  const [timeZone, setTimeZone] = useState("America/Los_Angeles");
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/calls?contactId=${contactId}`);
      const body = await res.json();
      setCall(body.call ?? null);
      if (body.timeZone) setTimeZone(body.timeZone);
    } catch {
      // Nothing to show is the safe default here.
    } finally {
      setLoaded(true);
    }
  }, [contactId]);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    if (!date || !time) {
      toast.error("Pick a date and a time");
      return;
    }
    setSaving(true);
    const res = await fetch("/api/calls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // A call already on the books is replaced rather than refused: the
      // reason to open this form when one exists is almost always to move it.
      body: JSON.stringify({ contactId, date, time, note, replace: true }),
    });
    setSaving(false);

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error ?? "Could not book that call");
      return;
    }
    toast.success(`Call booked with ${contactName}`);
    setOpen(false);
    setNote("");
    await load();
  }

  async function cancel() {
    if (!call) return;
    await fetch(`/api/calls/${call.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel" }),
    });
    await load();
  }

  if (!loaded) return null;

  return (
    <div className="rounded-xl border border-border/60 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Phone className="h-4 w-4" />
          <h3 className="text-sm font-semibold">Call</h3>
        </div>
        {!open && (
          <Button size="sm" variant={call ? "outline" : "default"} onClick={() => setOpen(true)}>
            {call ? "Change" : "Book a call"}
          </Button>
        )}
      </div>

      {call && !open && (
        <div className="space-y-1">
          <p className="text-sm font-medium">
            {new Intl.DateTimeFormat("en-US", {
              timeZone,
              weekday: "long",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            }).format(new Date(call.scheduled_at))}
          </p>
          {call.prospect_timezone !== timeZone && (
            <p className="text-xs text-muted-foreground">
              {new Intl.DateTimeFormat("en-US", {
                timeZone: call.prospect_timezone,
                hour: "numeric",
                minute: "2-digit",
                timeZoneName: "short",
              }).format(new Date(call.scheduled_at))}{" "}
              their time
            </p>
          )}
          {(call.note || call.source_quote) && (
            <p className="text-xs italic text-muted-foreground">
              {call.note ?? `“${call.source_quote}”`}
            </p>
          )}
          <div className="flex items-center gap-2 pt-1">
            <span className="text-[11px] text-muted-foreground">
              {call.status === "proposed"
                ? "Read from a message — not confirmed yet"
                : call.source === "manual"
                  ? "Booked by you"
                  : "Confirmed"}
            </span>
            <button
              type="button"
              onClick={cancel}
              className="text-[11px] text-muted-foreground underline hover:text-destructive"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {!call && !open && (
        <p className="text-xs text-muted-foreground">
          No call booked. One is added automatically when a lead asks for a time
          in Bonzo.
        </p>
      )}

      {open && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cd">Date</Label>
              <Input id="cd" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ct">Time</Label>
              <Input id="ct" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cn">What&apos;s it for?</Label>
            <Input
              id="cn"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Go through the HELOC numbers"
            />
            {/* Shown on the reminder — a call booked four days ago needs to
                still make sense when the phone buzzes. */}
            <p className="text-[11px] text-muted-foreground">
              Appears on the reminder so you know why you booked it.
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? "Booking…" : "Book"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
              <X className="mr-1 h-3.5 w-3.5" />
              Cancel
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Times are in your timezone. You&apos;ll get a reminder 15 minutes
            before and again when it starts.
          </p>
        </div>
      )}
    </div>
  );
}
