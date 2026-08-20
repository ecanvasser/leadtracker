import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { DailyQueue } from "./daily-queue";

export const instant = false;

export default async function DailyPage() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) redirect("/login");

  return <DailyQueue />;
}
