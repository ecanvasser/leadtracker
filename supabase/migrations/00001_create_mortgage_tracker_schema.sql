-- Enums
create type loan_type as enum
  ('cashout','rate_term','heloc','heloan','hei','purchase','hard_money','fast_50');
create type crm as enum ('bonzo','ghl');
create type pipeline_stage as enum ('hot_lead','app_in','submission','processing');

-- Contacts
create table contacts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  loan_type   loan_type not null,
  crm         crm not null,
  stage       pipeline_stage not null default 'hot_lead',
  position    double precision not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Tasks (to-dos)
create table tasks (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  contact_id   uuid not null references contacts(id) on delete cascade,
  title        text not null,
  is_done      boolean not null default false,
  due_date     date,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);

-- Telegram account linking
create table telegram_links (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  telegram_user_id bigint not null unique,
  created_at       timestamptz not null default now()
);

-- One-time deep-link tokens for linking (10-min expiry, single use)
create table telegram_link_tokens (
  token      uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  used       boolean not null default false,
  created_at timestamptz not null default now()
);

-- Idempotency: never process the same Telegram update twice
create table processed_updates (
  update_id    bigint primary key,
  processed_at timestamptz not null default now()
);

-- Indexes
create index idx_contacts_user_stage_pos on contacts (user_id, stage, position);
create index idx_tasks_user_done_due on tasks (user_id, is_done, due_date);
create index idx_tasks_contact on tasks (contact_id);

-- updated_at trigger
create or replace function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;
create trigger contacts_updated_at before update on contacts
  for each row execute function set_updated_at();

-- RLS
alter table contacts enable row level security;
alter table tasks enable row level security;
alter table telegram_links enable row level security;
alter table telegram_link_tokens enable row level security;

-- Contacts policies
create policy "Users can view own contacts" on contacts for select using (auth.uid() = user_id);
create policy "Users can insert own contacts" on contacts for insert with check (auth.uid() = user_id);
create policy "Users can update own contacts" on contacts for update using (auth.uid() = user_id);
create policy "Users can delete own contacts" on contacts for delete using (auth.uid() = user_id);

-- Tasks policies
create policy "Users can view own tasks" on tasks for select using (auth.uid() = user_id);
create policy "Users can insert own tasks" on tasks for insert with check (auth.uid() = user_id);
create policy "Users can update own tasks" on tasks for update using (auth.uid() = user_id);
create policy "Users can delete own tasks" on tasks for delete using (auth.uid() = user_id);

-- Telegram links policies
create policy "Users can view own telegram links" on telegram_links for select using (auth.uid() = user_id);
create policy "Users can insert own telegram links" on telegram_links for insert with check (auth.uid() = user_id);
create policy "Users can delete own telegram links" on telegram_links for delete using (auth.uid() = user_id);

-- Telegram link tokens policies
create policy "Users can view own link tokens" on telegram_link_tokens for select using (auth.uid() = user_id);
create policy "Users can insert own link tokens" on telegram_link_tokens for insert with check (auth.uid() = user_id);
create policy "Users can update own link tokens" on telegram_link_tokens for update using (auth.uid() = user_id);

-- Enable realtime for contacts and tasks
alter publication supabase_realtime add table contacts;
alter publication supabase_realtime add table tasks;
