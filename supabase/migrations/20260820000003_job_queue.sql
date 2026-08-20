-- =============================================================================
-- 0.8 — Durable job queue
--
-- Background work was fan-out executed synchronously inside request handlers.
-- generate/route.ts did contacts -> outreach -> insights -> model call ->
-- delete -> insert -> re-select in a single request, and cache refresh was
-- worse: N leads x (comms fetch + notes fetch + analyze call). At 40 hot leads
-- that exceeds serverless timeouts on any platform, and a mid-run failure left
-- no record of which leads had completed.
--
-- Scheduling lives in Postgres; application logic stays in the Next.js app.
-- pg_cron ticks, pg_net POSTs the Vercel worker with a bearer secret from
-- Vault, and the worker drains a bounded batch using the claim function below.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- jobs
-- ---------------------------------------------------------------------------
create table if not exists jobs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  contact_id   uuid references contacts(id) on delete cascade,
  job_type     text not null check (
                 job_type in ('refresh_cache','generate_queue_item','send_message',
                              'classify_lead','draft_reply','extract_call_time')
               ),
  payload      jsonb not null default '{}'::jsonb,
  status       text not null default 'pending' check (
                 status in ('pending','running','done','failed')
               ),
  attempts     int not null default 0,
  last_error   text,
  run_after    timestamptz not null default now(),
  locked_at    timestamptz,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);

-- The claim query orders by run_after among runnable rows.
create index if not exists idx_jobs_runnable
  on jobs (run_after, created_at)
  where status = 'pending';

create index if not exists idx_jobs_user_status on jobs (user_id, status);
create index if not exists idx_jobs_contact on jobs (contact_id);

-- Enqueue idempotency: at most one outstanding job of a given type per lead.
-- A tick that fires while the previous batch is still draining must not pile
-- up duplicate work.
create unique index if not exists idx_jobs_outstanding_unique
  on jobs (user_id, job_type, contact_id)
  where status in ('pending','running') and contact_id is not null;

-- The same, for jobs that are not scoped to a contact.
create unique index if not exists idx_jobs_outstanding_unique_global
  on jobs (user_id, job_type)
  where status in ('pending','running') and contact_id is null;

alter table jobs enable row level security;

-- Jobs are written and read only by the service role, which bypasses RLS.
-- A read-only policy lets the owner inspect their own queue from the app.
drop policy if exists "own_jobs_read" on jobs;
create policy "own_jobs_read" on jobs for select using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Refresh watermark
--
-- The refresh handler pulls the Bonzo communication history and compares it
-- against this to decide whether anything is actually new. That comparison is
-- what keeps polling off the model: roughly 1,000 refresh jobs a day are
-- Bonzo API calls only, and a model call fires solely when the watermark
-- moves. Without it, cost rises about 45x.
--
-- Bonzo's communication endpoint takes no date filter (only `only_activity`),
-- so the fetch is always a full history read and the diff happens here.
-- ---------------------------------------------------------------------------
alter table insights_cache add column if not exists last_synced_at timestamptz;

-- Newest message seen at the last sync. Compared against the freshly pulled
-- history to detect a genuinely new inbound or outbound message.
alter table insights_cache add column if not exists last_message_at timestamptz;

-- ---------------------------------------------------------------------------
-- claim_jobs
--
-- Atomic claim. `for update skip locked` means two overlapping ticks cannot
-- hand the same row to two workers: the second transaction skips rows the
-- first has locked rather than blocking on them.
--
-- Handlers must still be idempotent — a worker can die after claiming and
-- before completing, and the row will be retried.
-- ---------------------------------------------------------------------------
create or replace function claim_jobs(batch_size int default 5)
returns setof jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with claimed as (
    select j.id
    from jobs j
    where j.status = 'pending'
      and j.run_after <= now()
    order by j.run_after, j.created_at
    limit batch_size
    for update skip locked
  )
  update jobs
  set status = 'running',
      locked_at = now(),
      attempts = jobs.attempts + 1
  from claimed
  where jobs.id = claimed.id
  returning jobs.*;
end;
$$;

revoke all on function claim_jobs(int) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- reap_stuck_jobs
--
-- A worker that is killed mid-job (serverless timeout, deploy) leaves a row
-- stuck in 'running'. Return those to pending so they are retried rather than
-- lost. Retry accounting already happened at claim time.
-- ---------------------------------------------------------------------------
create or replace function reap_stuck_jobs(stuck_after interval default '10 minutes')
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  reaped int;
begin
  with revived as (
    update jobs
    set status = case when attempts >= 3 then 'failed' else 'pending' end,
        last_error = coalesce(last_error, 'Worker died before completing this job'),
        locked_at = null,
        completed_at = case when attempts >= 3 then now() else null end
    where status = 'running'
      and locked_at < now() - stuck_after
    returning 1
  )
  select count(*) into reaped from revived;
  return reaped;
end;
$$;

revoke all on function reap_stuck_jobs(interval) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Scheduling
--
-- pg_cron and pg_net must be enabled from the Supabase dashboard first
-- (Database -> Extensions); they cannot be enabled from a migration. This
-- block is skipped with a notice when they are absent so the migration still
-- applies cleanly to a local stack that has neither.
--
-- The URL and bearer token are read from Vault at execution time and are
-- never written into this file. Create them once in the SQL editor:
--
--   select vault.create_secret('https://<app>.vercel.app', 'worker_url');
--   select vault.create_secret('<long random string>', 'worker_secret');
--
-- The schedule is plain UTC on purpose. pg_cron runs in the database
-- timezone, so encoding working hours into the cron expression would be
-- wrong half the year; the worker gates on user_settings.timezone instead.
-- ---------------------------------------------------------------------------
do $$
declare
  has_cron boolean;
  has_net  boolean;
begin
  select exists (select 1 from pg_extension where extname = 'pg_cron') into has_cron;
  select exists (select 1 from pg_extension where extname = 'pg_net')  into has_net;

  if not has_cron or not has_net then
    raise notice 'pg_cron/pg_net not enabled — skipping worker schedule. Enable both in the Supabase dashboard, then re-run this migration.';
    return;
  end if;

  -- Idempotent: drop any previous definition before scheduling.
  perform cron.unschedule('leadtracker-worker-tick')
  where exists (select 1 from cron.job where jobname = 'leadtracker-worker-tick');

  perform cron.schedule(
    'leadtracker-worker-tick',
    '*/5 * * * *',
    $cron$
    select net.http_post(
      url := (
        select decrypted_secret from vault.decrypted_secrets where name = 'worker_url'
      ) || '/api/worker/drain',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret from vault.decrypted_secrets where name = 'worker_secret'
        )
      ),
      body := jsonb_build_object('source', 'cron'),
      timeout_milliseconds := 30000
    );
    $cron$
  );
end $$;
