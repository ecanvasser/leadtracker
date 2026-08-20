-- =============================================================================
-- Baseline schema — provisions LeadTracker from empty.
--
-- Every statement here is idempotent and forward-only. Nothing in this file
-- drops or recreates a table, a type, or a column that holds data.
--
-- Why idempotent rather than a plain CREATE script: the production project was
-- built by hand in the SQL editor and has NO rows in supabase_migrations.
-- schema_migrations. A `supabase db push` therefore attempts to apply this file
-- against a database where most of these objects already exist. Written this
-- way, the same file provisions a fresh local stack AND no-ops safely against
-- production. See README "Database setup" before pushing.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$ begin
  create type loan_type as enum
    ('cashout','rate_term','heloc','heloan','hei','purchase','hard_money','fast_50');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type crm as enum ('bonzo','ghl');
exception when duplicate_object then null;
end $$;

-- 'adverse' is included here for fresh databases. The alter below covers
-- databases created before it was added. ALTER TYPE ... ADD VALUE is
-- transaction-safe on PG 12+, but the new label cannot be *used* in the same
-- transaction that adds it — nothing in this file does.
do $$ begin
  create type pipeline_stage as enum
    ('hot_lead','app_in','submission','processing','adverse');
exception when duplicate_object then null;
end $$;

alter type pipeline_stage add value if not exists 'adverse';

do $$ begin
  create type adverse_reason as enum
    ('credit','equity','income','not_interested','other_lender','title_issue');
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- Contacts
-- ---------------------------------------------------------------------------
create table if not exists contacts (
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

-- Columns the app reads and writes that the original migration never declared.
alter table contacts add column if not exists adverse_reason    adverse_reason;
alter table contacts add column if not exists notes             text;
alter table contacts add column if not exists bonzo_prospect_id integer;
alter table contacts add column if not exists bonzo_email       text;
alter table contacts add column if not exists insights_enabled  boolean not null default false;

-- ---------------------------------------------------------------------------
-- Tasks (to-dos)
-- ---------------------------------------------------------------------------
create table if not exists tasks (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  contact_id   uuid not null references contacts(id) on delete cascade,
  title        text not null,
  is_done      boolean not null default false,
  due_date     date,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Telegram account linking
-- ---------------------------------------------------------------------------
create table if not exists telegram_links (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  telegram_user_id bigint not null unique,
  created_at       timestamptz not null default now()
);

-- One-time deep-link tokens for linking (10-min expiry, single use)
create table if not exists telegram_link_tokens (
  token      uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  used       boolean not null default false,
  created_at timestamptz not null default now()
);

-- Idempotency: never process the same Telegram update twice
create table if not exists processed_updates (
  update_id    bigint primary key,
  processed_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Insights cache
--
-- Queried throughout the app but never had a migration. Declared here to match
-- what production already holds.
-- ---------------------------------------------------------------------------
create table if not exists insights_cache (
  id                  uuid primary key default gen_random_uuid(),
  contact_id          uuid not null references contacts(id) on delete cascade,
  user_id             uuid not null references auth.users(id) on delete cascade,
  bonzo_prospect_data jsonb,
  bonzo_communication jsonb,
  ai_analysis         jsonb,
  generated_at        timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- The enable/refresh routes upsert with onConflict: "contact_id", which
-- requires a unique index on that column to resolve.
create unique index if not exists insights_cache_contact_id_key
  on insights_cache (contact_id);

-- ---------------------------------------------------------------------------
-- Outreach log — every action taken, used for cadence calculations
-- ---------------------------------------------------------------------------
create table if not exists outreach_log (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  contact_id    uuid not null references contacts(id) on delete cascade,
  action_type   text not null,
  status        text not null default 'sent',
  draft_message text,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Daily queue
--
-- queue_date intentionally has NO default. "Today" is a local-timezone concept
-- (see lib/time.ts); Postgres CURRENT_DATE is UTC and rolls over at 5pm
-- Pacific. The application always writes this column explicitly.
-- ---------------------------------------------------------------------------
create table if not exists daily_queue (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  contact_id         uuid not null references contacts(id) on delete cascade,
  queue_date         date not null,
  priority_rank      integer not null,
  priority_reason    text not null,
  action_type        text not null,
  draft_message      text,
  call_talking_points text,
  status             text not null default 'pending',
  completed_at       timestamptz,
  created_at         timestamptz not null default now()
);

-- Drop the UTC default on databases created before this migration.
alter table daily_queue alter column queue_date drop default;

-- A contact can legitimately have several actions of the same type on one day
-- (Day-0 leads get morning SMS + afternoon SMS), so there is deliberately no
-- unique constraint here. Dropped defensively for legacy databases.
drop index if exists daily_queue_contact_id_action_type_queue_date_idx;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index if not exists idx_contacts_user_stage_pos on contacts (user_id, stage, position);
create index if not exists idx_tasks_user_done_due     on tasks (user_id, is_done, due_date);
create index if not exists idx_tasks_contact           on tasks (contact_id);

create index if not exists idx_outreach_log_contact_created
  on outreach_log (contact_id, created_at desc);
create index if not exists idx_outreach_log_user_created
  on outreach_log (user_id, created_at desc);

create index if not exists idx_daily_queue_user_date_rank
  on daily_queue (user_id, queue_date, priority_rank);
create index if not exists idx_daily_queue_contact_date
  on daily_queue (contact_id, queue_date);

create index if not exists idx_insights_cache_user on insights_cache (user_id);

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists contacts_updated_at on contacts;
create trigger contacts_updated_at before update on contacts
  for each row execute function set_updated_at();

drop trigger if exists insights_cache_updated_at on insights_cache;
create trigger insights_cache_updated_at before update on insights_cache
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table contacts             enable row level security;
alter table tasks                enable row level security;
alter table telegram_links       enable row level security;
alter table telegram_link_tokens enable row level security;
alter table processed_updates    enable row level security;
alter table insights_cache       enable row level security;
alter table outreach_log         enable row level security;
alter table daily_queue          enable row level security;

drop policy if exists "Users can view own contacts"   on contacts;
drop policy if exists "Users can insert own contacts" on contacts;
drop policy if exists "Users can update own contacts" on contacts;
drop policy if exists "Users can delete own contacts" on contacts;
create policy "Users can view own contacts"   on contacts for select using (auth.uid() = user_id);
create policy "Users can insert own contacts" on contacts for insert with check (auth.uid() = user_id);
create policy "Users can update own contacts" on contacts for update using (auth.uid() = user_id);
create policy "Users can delete own contacts" on contacts for delete using (auth.uid() = user_id);

drop policy if exists "Users can view own tasks"   on tasks;
drop policy if exists "Users can insert own tasks" on tasks;
drop policy if exists "Users can update own tasks" on tasks;
drop policy if exists "Users can delete own tasks" on tasks;
create policy "Users can view own tasks"   on tasks for select using (auth.uid() = user_id);
create policy "Users can insert own tasks" on tasks for insert with check (auth.uid() = user_id);
create policy "Users can update own tasks" on tasks for update using (auth.uid() = user_id);
create policy "Users can delete own tasks" on tasks for delete using (auth.uid() = user_id);

drop policy if exists "Users can view own telegram links"   on telegram_links;
drop policy if exists "Users can insert own telegram links" on telegram_links;
drop policy if exists "Users can delete own telegram links" on telegram_links;
create policy "Users can view own telegram links"   on telegram_links for select using (auth.uid() = user_id);
create policy "Users can insert own telegram links" on telegram_links for insert with check (auth.uid() = user_id);
create policy "Users can delete own telegram links" on telegram_links for delete using (auth.uid() = user_id);

drop policy if exists "Users can view own link tokens"   on telegram_link_tokens;
drop policy if exists "Users can insert own link tokens" on telegram_link_tokens;
drop policy if exists "Users can update own link tokens" on telegram_link_tokens;
create policy "Users can view own link tokens"   on telegram_link_tokens for select using (auth.uid() = user_id);
create policy "Users can insert own link tokens" on telegram_link_tokens for insert with check (auth.uid() = user_id);
create policy "Users can update own link tokens" on telegram_link_tokens for update using (auth.uid() = user_id);

-- "own_insights" is the name production already uses; both are dropped so the
-- policy converges regardless of which database this runs against.
drop policy if exists "own_insights"       on insights_cache;
drop policy if exists "own_insights_cache" on insights_cache;
create policy "own_insights" on insights_cache
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own_outreach_log" on outreach_log;
create policy "own_outreach_log" on outreach_log
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own_daily_queue" on daily_queue;
create policy "own_daily_queue" on daily_queue
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- processed_updates is written only by the Telegram webhook using the service
-- role, which bypasses RLS. No policy is defined, so RLS denies all access to
-- anon and authenticated clients. That is intentional.

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table contacts;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter publication supabase_realtime add table tasks;
exception when duplicate_object then null;
end $$;
