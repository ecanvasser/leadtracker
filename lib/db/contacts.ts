import { SupabaseClient } from "@supabase/supabase-js";
import { Contact, LoanType, CRM, PipelineStage, AllStages, AdverseReason } from "@/types/db";

export async function getContactsByStage(
  supabase: SupabaseClient,
  stage: PipelineStage
) {
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("stage", stage)
    .order("position", { ascending: true });

  if (error) throw error;
  return data as Contact[];
}

export async function getAllContacts(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .order("position", { ascending: true });

  if (error) throw error;
  return data as Contact[];
}

export async function getContact(supabase: SupabaseClient, id: string) {
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", id)
    .single();

  if (error) throw error;
  return data as Contact;
}

export async function createContact(
  supabase: SupabaseClient,
  contact: {
    user_id: string;
    name: string;
    loan_type: LoanType;
    crm: CRM;
    stage?: PipelineStage;
  }
) {
  const { data: maxPos } = await supabase
    .from("contacts")
    .select("position")
    .eq("stage", contact.stage ?? "hot_lead")
    .order("position", { ascending: false })
    .limit(1)
    .single();

  const position = maxPos ? maxPos.position + 1000 : 1000;

  const { data, error } = await supabase
    .from("contacts")
    .insert({ ...contact, stage: contact.stage ?? "hot_lead", position })
    .select()
    .single();

  if (error) throw error;
  return data as Contact;
}

export async function updateContact(
  supabase: SupabaseClient,
  id: string,
  updates: Partial<Pick<Contact, "name" | "loan_type" | "crm" | "stage" | "position" | "adverse_reason" | "notes">>
) {
  const { data, error } = await supabase
    .from("contacts")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  return data as Contact;
}

export async function deleteContact(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from("contacts").delete().eq("id", id);
  if (error) throw error;
}

export async function moveContact(
  supabase: SupabaseClient,
  id: string,
  newStage: AllStages,
  newPosition: number
) {
  const { data, error } = await supabase
    .from("contacts")
    .update({ stage: newStage, position: newPosition })
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  return data as Contact;
}
