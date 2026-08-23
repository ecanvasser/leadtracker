"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * Phase 8 section 5. Today is first because it is now home; Adverse and Funded
 * came off the top level because they are terminal lists reached from the
 * board, not places to work.
 *
 * /daily is labelled Queue rather than Daily — the route stays, since renaming
 * it would break every link and bookmark to no benefit.
 */
const LINKS = [
  { href: "/today", label: "Today" },
  { href: "/board", label: "Board" },
  { href: "/daily", label: "Queue" },
  { href: "/workflows", label: "Workflows" },
  { href: "/settings", label: "Settings" },
] as const;

/**
 * Primary navigation.
 *
 * The badge moved from the queue's pending count to Today's "Your move"
 * count, because that is now the number that decides whether the app needs
 * opening at all. It is read from /api/today/summary, which calls the same
 * loadToday the screen does — a badge that disagrees with the page it links
 * to is worse than no badge.
 */
export function AppNav() {
  const pathname = usePathname();
  const [yourMove, setYourMove] = useState(0);
  const [queuePending, setQueuePending] = useState(0);
  const supabase = createClient();

  const load = useCallback(async () => {
    const [today, queue] = await Promise.allSettled([
      fetch("/api/today/summary").then((r) => r.json()),
      fetch("/api/daily-queue/summary").then((r) => r.json()),
    ]);
    if (today.status === "fulfilled") setYourMove(today.value?.your_move ?? 0);
    if (queue.status === "fulfilled") setQueuePending(queue.value?.pending ?? 0);
  }, []);

  useEffect(() => {
    load();
  }, [load, pathname]);

  useEffect(() => {
    /*
     * The counts change from places this tab cannot see: the worker writing a
     * watermark, a Telegram action, a stage change in another tab. Coalesced
     * into one refetch because a single refresh sweep can touch a dozen cache
     * rows in a burst, and each one would otherwise be its own round trip.
     */
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 400);
    };

    const channel = supabase
      .channel("nav-counts")
      .on("postgres_changes", { event: "*", schema: "public", table: "daily_queue" }, bump)
      .on("postgres_changes", { event: "*", schema: "public", table: "contacts" }, bump)
      .on("postgres_changes", { event: "*", schema: "public", table: "insights_cache" }, bump)
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, bump)
      .subscribe();

    return () => {
      clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [supabase, load]);

  return (
    <div className="flex items-center gap-1 text-sm text-muted-foreground">
      {LINKS.map(({ href, label }) => {
        // startsWith so /contacts/:id does not orphan the nav, but exact for
        // the root sections themselves.
        const active = pathname === href || pathname.startsWith(`${href}/`);
        const count = href === "/today" ? yourMove : href === "/daily" ? queuePending : 0;

        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`relative px-3 py-1.5 rounded-md transition-colors ${
              active
                ? "text-foreground bg-accent font-medium"
                : "hover:text-foreground hover:bg-accent/60"
            }`}
          >
            {label}
            {count > 0 && (
              <span
                className={`absolute -top-1 -right-1 h-4 min-w-4 px-1 flex items-center justify-center rounded-full text-[10px] font-bold tabular-nums ${
                  href === "/today"
                    ? "bg-red-500 text-white"
                    : // The queue is a secondary count now. Two red badges
                      // compete, and only one of them answers "is there
                      // anything I have to do".
                      "bg-muted-foreground/25 text-foreground"
                }`}
              >
                {count > 99 ? "99+" : count}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
