import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { RulesClient } from "./rules-client";

export const instant = false;

/**
 * Phase 8 section 6 — the two rules, in plain English.
 *
 * The generic builder that used to live here is not deleted; it is unlinked,
 * at /workflows/advanced. Restoring it is changing this import back.
 */
export default async function WorkflowsPage() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();

  if (!authData?.claims) {
    redirect("/login");
  }

  return <RulesClient />;
}
