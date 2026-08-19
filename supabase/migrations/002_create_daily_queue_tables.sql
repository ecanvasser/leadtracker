-- Track every outreach action for cadence calculations
create table outreach_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  action_type text not null,
  status text not null default 'sent',
  draft_message text,
  created_at timestamptz not null default now()
);

create index on outreach_log (contact_id, created_at desc);
create index on outreach_log (user_id, created_at desc);

alter table outreach_log enable row level security;

create policy "own_outreach_log" on outreach_log
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Daily queue state (what's been generated for today, per contact)
create table daily_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  queue_date date not null default current_date,
  priority_rank integer not null,
  priority_reason text not null,
  action_type text not null,
  draft_message text,
  call_talking_points text,
  status text not null default 'pending',
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index on daily_queue (user_id, queue_date, priority_rank);
create index on daily_queue (contact_id, queue_date);
-- No unique constraint — a contact can have multiple actions of the same type
-- per day (e.g. morning SMS + afternoon SMS on Day 1).

alter table daily_queue enable row level security;

create policy "own_daily_queue" on daily_queue
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
