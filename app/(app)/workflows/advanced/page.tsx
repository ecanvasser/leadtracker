import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { WorkflowsClient } from "../workflows-client";

export const instant = false;

/**
 * The generic workflow builder — six triggers x six actions, thirty-six
 * combinations — kept at an unlinked URL (Phase 8 section 6).
 *
 * Nothing links here. It is reachable by typing the address, which is the
 * point: the bet is that two rules are enough, and the cost of being wrong
 * about that should be one navigation rather than a rewrite. If a third rule
 * turns out to be worth having, this is where it gets built, and /workflows
 * can be pointed back at WorkflowsClient in one line.
 *
 * Anything created here still evaluates, and still appears on /workflows under
 * "Other rules" — a rule that fires without showing up on the page that claims
 * to list the rules would be the worst failure that page could have.
 */
export default async function AdvancedWorkflowsPage() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();

  if (!authData?.claims) {
    redirect("/login");
  }

  return <WorkflowsClient />;
}
