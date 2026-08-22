import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { WorkflowsClient } from "./workflows-client";

export const instant = false;

export default async function WorkflowsPage() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();

  if (!authData?.claims) {
    redirect("/login");
  }

  return <WorkflowsClient />;
}
