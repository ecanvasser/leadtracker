import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { LogoutButton } from "@/components/logout-button";
import { Toaster } from "@/components/ui/sonner";

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
    <div className="min-h-screen flex flex-col">
      <nav className="border-b border-border/50 h-14 flex items-center px-4 md:px-6 shrink-0">
        <div className="flex items-center gap-6 w-full">
          <Link
            href="/board"
            className="font-semibold text-sm tracking-tight"
          >
            Mortgage Tracker
          </Link>
          <div className="flex items-center gap-1 text-sm text-muted-foreground">
            <Link
              href="/board"
              className="px-3 py-1.5 rounded-md hover:text-foreground hover:bg-accent transition-colors"
            >
              Board
            </Link>
            <Link
              href="/daily"
              className="px-3 py-1.5 rounded-md hover:text-foreground hover:bg-accent transition-colors"
            >
              Daily
            </Link>
            <Link
              href="/adverse"
              className="px-3 py-1.5 rounded-md hover:text-foreground hover:bg-accent transition-colors"
            >
              Adverse
            </Link>
            <Link
              href="/settings"
              className="px-3 py-1.5 rounded-md hover:text-foreground hover:bg-accent transition-colors"
            >
              Settings
            </Link>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <ThemeSwitcher />
            <LogoutButton />
          </div>
        </div>
      </nav>
      <main className="flex-1 flex flex-col">{children}</main>
      <Toaster />
    </div>
  );
}
