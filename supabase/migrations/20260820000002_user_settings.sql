-- =============================================================================
-- 0.2 — user_settings
--
-- Holds the per-user configuration the rest of the rework reads: timezone
-- first (nothing schedule-related is correct without it), plus the voice
-- profile, broker identity, cadence constants, quiet hours and token budget
-- defined later in the spec.
--
-- Single table, single migration: these are all one row per user and get read
-- together on nearly every request.
-- =============================================================================

create table if not exists user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,

  -- 0.2 Timezones -----------------------------------------------------------
  -- Every "today" in the app is derived from this, never from UTC.
  timezone text not null default 'America/Los_Angeles',

  -- 1.3 Broker identity, used by the opener constraint ----------------------
  broker_display_name text not null default 'Eddie Canvasser',
  broker_company      text not null default 'E Mortgage Capital',

  -- 1.2 Voice profile -------------------------------------------------------
  -- Extracted on demand from real outbound messages; null until generated.
  voice_profile jsonb,
  voice_profile_generated_at timestamptz,

  -- 1.5 Cadence configuration ----------------------------------------------
  -- Constants formerly hardcoded in lib/cadence/engine.ts. work_sunday
  -- replaces the hardcoded isSunday() bail-out.
  cadence_config jsonb not null default jsonb_build_object(
    'work_sunday', false,
    'work_saturday', true,
    'saturday_max_messages', 1,
    'saturday_calls', false,
    'unresponsive_max_consecutive', 5,
    'blocked_min_days_between_touches', 21,
    'in_market_max_age_days', 14
  ),

  -- 2.3 Push scheduling -----------------------------------------------------
  -- All stored as local wall-clock times, interpreted in `timezone` above.
  morning_digest_time time not null default '08:00',
  quiet_hours_start   time not null default '21:00',
  quiet_hours_end     time not null default '08:00',

  -- Working hours gate the pg_cron tick (0.8) and cache refresh (2.4).
  working_hours_start time not null default '08:00',
  working_hours_end   time not null default '19:00',

  -- C6 Cost controls --------------------------------------------------------
  -- When the day's usage exceeds this, the worker stops making model calls,
  -- finishes the queue with existing drafts, and pushes a Telegram warning.
  daily_token_budget integer not null default 2000000,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Columns are added defensively so re-running against a database that already
-- has an earlier version of this table converges rather than erroring.
alter table user_settings add column if not exists timezone text not null default 'America/Los_Angeles';
alter table user_settings add column if not exists broker_display_name text not null default 'Eddie Canvasser';
alter table user_settings add column if not exists broker_company text not null default 'E Mortgage Capital';
alter table user_settings add column if not exists voice_profile jsonb;
alter table user_settings add column if not exists voice_profile_generated_at timestamptz;
alter table user_settings add column if not exists morning_digest_time time not null default '08:00';
alter table user_settings add column if not exists quiet_hours_start time not null default '21:00';
alter table user_settings add column if not exists quiet_hours_end time not null default '08:00';
alter table user_settings add column if not exists working_hours_start time not null default '08:00';
alter table user_settings add column if not exists working_hours_end time not null default '19:00';
alter table user_settings add column if not exists daily_token_budget integer not null default 2000000;

-- A bad timezone string silently breaks every date computation in the app, so
-- reject it at write time rather than discovering it in a draft six hours off.
do $$ begin
  alter table user_settings add constraint user_settings_timezone_valid
    check (now() at time zone timezone is not null) not valid;
exception when duplicate_object then null;
end $$;

drop trigger if exists user_settings_updated_at on user_settings;
create trigger user_settings_updated_at before update on user_settings
  for each row execute function set_updated_at();

alter table user_settings enable row level security;

drop policy if exists "own_user_settings" on user_settings;
create policy "own_user_settings" on user_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Backfill a settings row for every existing user so the app never has to
-- handle a missing row on the read path.
insert into user_settings (user_id)
select id from auth.users
on conflict (user_id) do nothing;
