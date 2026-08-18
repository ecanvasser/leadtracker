import { SupabaseClient } from "@supabase/supabase-js";
import { Task, TaskWithContact } from "@/types/db";

export async function getOpenTasks(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("tasks")
    .select("*, contacts(name, loan_type)")
    .eq("is_done", false)
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data as TaskWithContact[];
}

export async function getTasksForContact(
  supabase: SupabaseClient,
  contactId: string
) {
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("contact_id", contactId)
    .order("is_done", { ascending: true })
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data as Task[];
}

export async function createTask(
  supabase: SupabaseClient,
  task: {
    user_id: string;
    contact_id: string;
    title: string;
    due_date?: string | null;
  }
) {
  const { data, error } = await supabase
    .from("tasks")
    .insert(task)
    .select("*, contacts(name, loan_type)")
    .single();

  if (error) throw error;
  return data as TaskWithContact;
}

export async function completeTask(supabase: SupabaseClient, id: string) {
  const { data, error } = await supabase
    .from("tasks")
    .update({ is_done: true, completed_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  return data as Task;
}

export async function deleteTask(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from("tasks").delete().eq("id", id);
  if (error) throw error;
}

export async function getTaskCountsForContacts(
  supabase: SupabaseClient
): Promise<Record<string, number>> {
  const { data, error } = await supabase
    .from("tasks")
    .select("contact_id")
    .eq("is_done", false);

  if (error) throw error;

  const counts: Record<string, number> = {};
  for (const row of data) {
    counts[row.contact_id] = (counts[row.contact_id] || 0) + 1;
  }
  return counts;
}
