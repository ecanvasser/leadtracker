-- =============================================================================
-- 2.1 — Telegram session storage
--
-- lib/telegram/commands.ts held multi-step flow state in a module-level
-- `new Map<number, ...>()`. On serverless that map lives in one lambda's
-- memory: the next update in a flow frequently lands on a different instance
-- with an empty map, so /add and /move silently forget what you told them.
--
-- Sessions are short-lived UI state, not data, so rows carry a TTL and are
-- reaped rather than kept.
-- =============================================================================

create table if not exists telegram_sessions (
  telegram_user_id bigint primary key,
  data             jsonb not null default '{}'::jsonb,
  expires_at       timestamptz not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_telegram_sessions_expiry
  on telegram_sessions (expires_at);

drop trigger if exists telegram_sessions_updated_at on telegram_sessions;
create trigger telegram_sessions_updated_at before update on telegram_sessions
  for each row execute function set_updated_at();

alter table telegram_sessions enable row level security;

-- Written only by the webhook using the service role, which bypasses RLS.
-- No policy is defined, so anon and authenticated are denied entirely. A
-- session row is keyed by Telegram id and has no user_id to scope on, which
-- is another reason not to expose it to the client.

-- Expired sessions are treated as empty on read; this reaps the rows so the
-- table does not grow without bound.
create or replace function reap_telegram_sessions()
returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare
  removed int;
begin
  with gone as (
    delete from telegram_sessions where expires_at < now() returning 1
  )
  select count(*) into removed from gone;
  return removed;
end;
$fn$;

revoke all on function reap_telegram_sessions() from public, anon, authenticated;
