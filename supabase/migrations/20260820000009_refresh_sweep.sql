-- =============================================================================
-- 2.4 — Cache refresh sweep
--
-- The tick runs every 5 minutes but leads are only swept every 15, and only
-- inside working hours. That gating cannot live in the cron expression:
-- pg_cron runs in the database timezone, so an hours-based schedule would be
-- wrong for half the year and wrong again for a second user in another zone.
-- The worker gates on user_settings.timezone instead; this column records when
-- the last sweep happened so the interval survives a restart.
-- =============================================================================

alter table user_settings
  add column if not exists last_refresh_sweep_at timestamptz;

-- ---------------------------------------------------------------------------
-- Inbound reply watermark
--
-- refresh_cache already tracks last_message_at across all messages. Detecting
-- a *reply* specifically needs the inbound side tracked separately: an
-- outbound send moves last_message_at, and without this an inbound arriving
-- afterwards could be missed.
-- ---------------------------------------------------------------------------
alter table insights_cache
  add column if not exists last_inbound_at timestamptz;

-- Set the initial watermark from what is already cached, so enabling this does
-- not treat every historical reply as new and push a card for each.
--
-- Bonzo writes "incoming"/"outgoing", not "inbound"/"outbound". Matching only
-- the latter would leave every watermark NULL, and the first sweep would then
-- treat every historical reply as new — a burst of approval cards for
-- conversations that are months old, plus a classification and a draft for
-- each. Both vocabularies are accepted because cached payloads may predate
-- the normalisation in lib/bonzo/client.ts.
update insights_cache
set last_inbound_at = (
  select max((m ->> 'created_at')::timestamptz)
  from jsonb_array_elements(bonzo_communication) as m
  where lower(m ->> 'direction') in ('incoming', 'inbound', 'in', 'received')
)
where last_inbound_at is null
  and bonzo_communication is not null
  and jsonb_typeof(bonzo_communication) = 'array';
