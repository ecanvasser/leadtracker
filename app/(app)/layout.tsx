import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { LogoutButton } from "@/components/logout-button";
import { Toaster } from "@/components/ui/sonner";
import { PageTransition } from "@/components/page-transition";
import { AppNav } from "@/components/app-nav";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    redirect("/login");
  }

  return (
    // h-dvh, not min-h-screen. A min-height gives the flex chain no definite
    // height to divide, so every flex-1 below just grew to fit its content —
    // which is why the board columns spilled past their own border and why
    // contact-detail's overflow-y-auto panes never actually scrolled. dvh
    // rather than vh so mobile browser chrome is accounted for.
    <div className="h-dvh flex flex-col overflow-hidden">
      <nav className="border-b border-border/50 h-14 flex items-center px-4 md:px-6 shrink-0">
        <div className="flex items-center gap-6 w-full">
          <Link
            href="/board"
            className="font-semibold text-sm tracking-tight"
          >
            Mortgage Tracker
          </Link>
          <AppNav />
          <div className="ml-auto flex items-center gap-3">
            <ThemeSwitcher />
            <LogoutButton />
          </div>
        </div>
      </nav>
      {/* Scrolls by default so ordinary pages behave normally. A page that
          manages its own scrolling (the board, contact detail) fills exactly
          this height, so this never scrolls for them. */}
      <main className="flex-1 min-h-0 flex flex-col overflow-y-auto">
        <PageTransition>{children}</PageTransition>
      </main>
      <Toaster />
    </div>
  );
}
