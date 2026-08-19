import { createClient } from "@/lib/supabase/server";
import { DailyQueue } from "./daily-queue";

export const instant = false;

export default async function DailyPage() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  const userId = authData?.claims?.sub as string;

  return <DailyQueue userId={userId} />;
}
