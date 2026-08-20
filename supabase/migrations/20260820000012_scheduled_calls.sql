-- =============================================================================
-- 3.1 / 3.4 — Scheduled calls
--
-- Reminders only. Nothing here dials, and nothing stores a tel: link. The app
-- reminds and deep links to Bonzo; the call happens there.
-- =============================================================================

-- 3.4 — search-bonzo fetched prospect.phone, showed it once and threw it away.
-- A reminder is useless without a number to read off.
alter table contacts add column if not exists phone text;

create table if not exists scheduled_calls (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  contact_id   uuid not null references contacts(id) on delete cascade,

  -- The instant, plus the zone it was interpreted in. Storing both is what
  -- makes DST correct: a fixed offset captured today is wrong after the next
  -- transition, and "Thursday at 2" six weeks out crosses one.
  scheduled_at      timestamptz not null,
  prospect_timezone text not null,

  -- How that zone was determined, so the broker knows how much to trust it.
  -- 'property_state' > 'area_code' > 'broker_default', in that order.
  timezone_source text not null check (
    timezone_source in ('property_state', 'area_code', 'broker_default')
  ),

  -- The message this was read out of, and its exact words. A reminder that
  -- cannot show what was agreed to is a reminder you cannot trust.
  source_message_id text,
  source_quote      text not null,

  -- Detected calls land as 'proposed' and are confirmed in Telegram. Never
  -- auto-confirmed: a misparsed time is worse than no reminder at all.
  status text not null default 'proposed' check (
    status in ('proposed', 'confirmed', 'completed', 'missed', 'cancelled', 'rescheduled')
  ),

  -- Which reminders have gone out, so a restart cannot re-send them.
  reminded_t15_at timestamptz,
  reminded_t0_at  timestamptz,
  outcome_asked_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The dispatcher's query: confirmed calls with a reminder still owing.
create index if not exists idx_scheduled_calls_due
  on scheduled_calls (scheduled_at)
  where status = 'confirmed';

create index if not exists idx_scheduled_calls_contact
  on scheduled_calls (contact_id, scheduled_at desc);

create index if not exists idx_scheduled_calls_user_status
  on scheduled_calls (user_id, status);

-- One live call per contact at a time. A second detection for the same lead
-- should update the existing row rather than stack duplicate reminders.
create unique index if not exists idx_scheduled_calls_one_live
  on scheduled_calls (contact_id)
  where status in ('proposed', 'confirmed');

drop trigger if exists scheduled_calls_updated_at on scheduled_calls;
create trigger scheduled_calls_updated_at before update on scheduled_calls
  for each row execute function set_updated_at();

alter table scheduled_calls enable row level security;

drop policy if exists "own_scheduled_calls" on scheduled_calls;
create policy "own_scheduled_calls" on scheduled_calls
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Detection watermark: only messages newer than this are scanned, so the
-- extraction pass does not re-read the whole history on every refresh.
alter table insights_cache
  add column if not exists calls_scanned_through timestamptz;
