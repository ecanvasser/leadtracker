import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { Board } from "@/components/board/board";

export const instant = false;

export default async function BoardPage() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();

  if (!authData?.claims) {
    redirect("/login");
  }

  const userId = authData.claims.sub as string;

  const [contactsRes, tasksRes] = await Promise.all([
    supabase
      .from("contacts")
      .select("*")
      .order("position", { ascending: true }),
    supabase
      .from("tasks")
      .select("*, contacts(name, loan_type)")
      .eq("is_done", false)
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true }),
  ]);

  const taskCounts: Record<string, number> = {};
  if (tasksRes.data) {
    for (const task of tasksRes.data) {
      taskCounts[task.contact_id] = (taskCounts[task.contact_id] || 0) + 1;
    }
  }

  return (
    <Board
      initialContacts={contactsRes.data ?? []}
      initialTasks={tasksRes.data ?? []}
      initialTaskCounts={taskCounts}
      userId={userId}
    />
  );
}
