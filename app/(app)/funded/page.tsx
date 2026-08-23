import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { FundedTable } from "./funded-table";

export const instant = false;

export default async function FundedPage() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();

  if (!authData?.claims) {
    redirect("/login");
  }

  const userId = authData.claims.sub as string;

  const { data: contacts } = await supabase
    .from("contacts")
    .select("*")
    .eq("stage", "funded")
    .order("stage_changed_at", { ascending: false });

  return <FundedTable initialContacts={contacts ?? []} userId={userId} />;
}
