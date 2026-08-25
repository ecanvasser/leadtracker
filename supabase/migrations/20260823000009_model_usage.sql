-- =============================================================================
-- model_usage — one row per model call.
--
-- The daily token budget has been a column on user_settings since Phase 0 and
-- has never been enforced, because nothing recorded what had been spent.
-- Usage was returned by callModel and written into decision_trace on the queue
-- rows that happened to have one, which covers queue generation and nothing
-- else: classification, prospect analysis, call extraction and drafting all
-- returned their usage to a caller that dropped it. The Settings page's
-- "today's spend" therefore reported a fraction of the real number, and the
-- budget could not be checked at all.
--
-- A ledger rather than a counter, because the point stated in callModel's own
-- comment is being able to see *which part of the system* is spending, not
-- just a total. One row per call keeps that, and the total is a sum.
--
-- Deliberately not foreign-keyed to contacts: a call made about a lead that is
-- later deleted still cost money, and the spend record should outlive the
-- lead. contact_id is a plain uuid for attribution only.
-- =============================================================================

create table if not exists model_usage (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,

  -- Which part of the system spent this. Free text rather than an enum so a
  -- new call site cannot be blocked from recording by a migration it forgot.
  purpose    text not null,
  model      text not null,
  contact_id uuid,

  input_tokens             integer not null default 0,
  output_tokens            integer not null default 0,
  cache_read_input_tokens  integer not null default 0,
  latency_ms               integer,

  created_at timestamptz not null default now()
);

-- The budget query: everything one user spent since the start of their local
-- day. Local-day bounds are computed in the application (lib/time.ts) and
-- passed as real UTC instants, so this only ever needs the range scan.
create index if not exists idx_model_usage_user_created
  on model_usage (user_id, created_at desc);

alter table model_usage enable row level security;

drop policy if exists "own_model_usage" on model_usage;
create policy "own_model_usage" on model_usage
  for select using (auth.uid() = user_id);

-- Writes come from the worker under the service role, which bypasses RLS.
-- No insert policy is granted deliberately: a browser session has no business
-- writing spend records, and the Settings page only reads.

-- ---------------------------------------------------------------------------
-- The over-budget warning is pushed once a day, not once per blocked call.
-- Without this a budget hit at 9am would send a Telegram message every five
-- minutes until midnight.
-- ---------------------------------------------------------------------------
alter table user_settings
  add column if not exists last_budget_warning_date date;

comment on column user_settings.last_budget_warning_date is
  'Local date of the last over-budget Telegram warning. Claimed before the '
  'push so a retry cannot send a second one.';
