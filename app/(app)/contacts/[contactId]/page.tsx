import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { ContactDetail } from "./contact-detail";

export const instant = false;

export default async function ContactPage({
  params,
}: {
  params: Promise<{ contactId: string }>;
}) {
  const { contactId } = await params;
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();

  if (!authData?.claims) {
    redirect("/login");
  }

  const userId = authData.claims.sub as string;

  const { data: contact } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", contactId)
    .single();

  if (!contact) {
    redirect("/board");
  }

  const { data: tasks } = await supabase
    .from("tasks")
    .select("*")
    .eq("contact_id", contactId)
    .order("is_done", { ascending: true })
    .order("created_at", { ascending: false });

  return (
    <ContactDetail
      contact={contact}
      initialTasks={tasks ?? []}
      userId={userId}
    />
  );
}
