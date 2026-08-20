-- =============================================================================
-- 1.4 — lead_state
--
-- The structured decision record behind every recommendation, so a suggestion
-- can be audited rather than taken on faith. One row per lead, replaced on
-- each reclassification.
--
-- Stored as jsonb rather than columns: the shape is model output that will be
-- tuned, and a schema migration per field change would be friction with no
-- benefit. Queries filter on a handful of extracted keys, indexed below.
-- =============================================================================

alter table insights_cache add column if not exists lead_state jsonb;

-- When the last classification ran, so a stale record is visible as stale.
alter table insights_cache add column if not exists lead_state_at timestamptz;

-- The queue and board filter on temperature and blocker constantly. Indexing
-- the extracted keys avoids a full scan of the jsonb on every read.
create index if not exists idx_insights_cache_lead_temp
  on insights_cache ((lead_state ->> 'lead_temp'))
  where lead_state is not null;

create index if not exists idx_insights_cache_blocker
  on insights_cache ((lead_state ->> 'blocker'))
  where lead_state is not null;

-- A lead can be suppressed until a date (a blocker that cannot move before
-- then). Queue generation checks this on every run.
create index if not exists idx_insights_cache_suppress_until
  on insights_cache ((lead_state ->> 'suppress_until'))
  where lead_state is not null;
