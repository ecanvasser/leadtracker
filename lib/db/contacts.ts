import { SupabaseClient } from "@supabase/supabase-js";
import { Contact, LoanType, CRM, PipelineStage, AllStages, DEFAULT_STAGE } from "@/types/db";

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

/**
 * Finds a contact already linked to a Bonzo prospect, in ANY stage.
 *
 * 5.2 — the import path used to scope this to hot_lead, which meant the same
 * prospect could be imported twice into two different columns with no warning.
 * Stage is deliberately not filtered: a duplicate in Adverse or Processing is
 * still a duplicate, and knowing which stage it sits in is the useful part of
 * the answer.
 *
 * The prospect id is checked first because it is the real key. bonzo_email is a
 * fallback for rows written before the id was stored.
 */
export async function findExistingBonzoContact(
  supabase: SupabaseClient,
  match: { prospectId?: number | null; email?: string | null }
): Promise<Pick<Contact, "id" | "name" | "stage"> | null> {
  const select = "id, name, stage";

  if (match.prospectId != null) {
    const { data } = await supabase
      .from("contacts")
      .select(select)
      .eq("bonzo_prospect_id", match.prospectId)
      .limit(1)
      .maybeSingle();
    if (data) return data as Pick<Contact, "id" | "name" | "stage">;
  }

  const email = match.email?.trim();
  if (email) {
    const { data } = await supabase
      .from("contacts")
      .select(select)
      .ilike("bonzo_email", email)
      .limit(1)
      .maybeSingle();
    if (data) return data as Pick<Contact, "id" | "name" | "stage">;
  }

  return null;
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
  // Position is computed inside the *target* stage, not the default one, so a
  // contact created directly into App In lands at the bottom of App In.
  const stage = contact.stage ?? DEFAULT_STAGE;

  const { data: maxPos } = await supabase
    .from("contacts")
    .select("position")
    .eq("stage", stage)
    .order("position", { ascending: false })
    .limit(1)
    .single();

  const position = maxPos ? maxPos.position + 1000 : 1000;

  const { data, error } = await supabase
    .from("contacts")
    .insert({ ...contact, stage, position })
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
