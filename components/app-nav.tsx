"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const LINKS = [
  { href: "/board", label: "Board" },
  { href: "/daily", label: "Daily" },
  { href: "/adverse", label: "Adverse" },
  { href: "/settings", label: "Settings" },
] as const;

/**
 * Primary navigation.
 *
 * Two things the previous version lacked: any indication of where you are, and
 * a pending count anywhere except the board — which is the one page you are
 * least likely to be on when it matters.
 */
export function AppNav() {
  const pathname = usePathname();
  const [pending, setPending] = useState(0);
  const supabase = createClient();

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/daily-queue/summary");
        const data = await res.json();
        if (!cancelled) setPending(data.pending ?? 0);
      } catch {
        // A failed count is not worth surfacing; the badge just stays put.
      }
    }

    load();

    // The count changes when the worker pushes work or an item is actioned
    // from Telegram, neither of which this tab knows about otherwise.
    const channel = supabase
      .channel("nav-queue-count")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "daily_queue" },
        () => load()
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [supabase]);

  return (
    <div className="flex items-center gap-1 text-sm text-muted-foreground">
      {LINKS.map(({ href, label }) => {
        // startsWith so /contacts/:id does not orphan the nav, but exact for
        // the root sections themselves.
        const active = pathname === href || pathname.startsWith(`${href}/`);

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
            {href === "/daily" && pending > 0 && (
              <span className="absolute -top-1 -right-1 h-4 min-w-4 px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold tabular-nums">
                {pending > 99 ? "99+" : pending}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
