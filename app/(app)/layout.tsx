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
    <div className="min-h-screen flex flex-col">
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
      <main className="flex-1 flex flex-col">
        <PageTransition>{children}</PageTransition>
      </main>
      <Toaster />
    </div>
  );
}
