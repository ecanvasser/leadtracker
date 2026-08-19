const BASE_URL = "https://app.getbonzo.com/api";

function getToken(): string {
  const token = process.env.BONZO_API_TOKEN;
  if (!token) throw new Error("BONZO_API_TOKEN not set");
  return token;
}

async function bonzoFetch(path: string): Promise<Response> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: "application/json",
    },
  });

  if (res.status === 401) {
    throw new Error("Bonzo authentication failed — check your API token");
  }

  if (!res.ok) {
    throw new Error(`Bonzo API error: ${res.status} ${res.statusText}`);
  }

  return res;
}

export interface BonzoMortgageFields {
  loan_type?: string | null;
  loan_purpose?: string | null;
  loan_amount?: string | null;
  credit_score?: string | null;
  property_address?: string | null;
  property_value?: string | null;
  down_payment?: string | null;
  annual_income?: string | null;
  employment_status?: string | null;
  agent_name?: string | null;
  agent_email?: string | null;
  agent_phone?: string | null;
}

export interface BonzoProspect {
  id: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  status: string | null;
  pipeline_stage: string | null;
  tags: string[];
  mortgage_fields: BonzoMortgageFields | null;
  created_at: string;
  updated_at: string;
}

export interface BonzoCommunication {
  id: number;
  content: string | null;
  direction: string;
  type: string;
  subject: string | null;
  status: string | null;
  created_at: string;
  user_name: string | null;
  source: string | null;
}

export interface BonzoNote {
  id: number;
  content: string;
  created_at: string;
  user_name: string | null;
}

export async function searchProspectByEmail(
  email: string
): Promise<BonzoProspect | null> {
  const res = await bonzoFetch(
    `/v3/prospects?search=${encodeURIComponent(email)}`
  );
  const json = await res.json();
  const prospects: BonzoProspect[] = json.data ?? json ?? [];

  const match = prospects.find(
    (p) => p.email?.toLowerCase() === email.toLowerCase()
  );
  return match ?? null;
}

export async function getCommunicationHistory(
  prospectId: number
): Promise<BonzoCommunication[]> {
  const res = await bonzoFetch(`/v3/prospects/${prospectId}/communication`);
  const json = await res.json();
  return json.data ?? json ?? [];
}

export async function getProspectNotes(
  prospectId: number
): Promise<BonzoNote[]> {
  const res = await bonzoFetch(`/v3/prospects/${prospectId}/notes`);
  const json = await res.json();
  return json.data ?? json ?? [];
}
