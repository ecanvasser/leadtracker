-- =============================================================================
-- "Wants to talk, no time set."
--
-- The detector answers one question well: what time did they agree to? It has
-- nothing to say about the case that surfaced this — a lead who writes "let's
-- talk in the morning, what time are you available?" and never names an hour.
-- There is no time to extract, the scan correctly finds nothing, and the whole
-- exchange produces silence indistinguishable from a thread with no call in
-- it at all.
--
-- That is the worst case to be silent about. A lead who asked for a call and
-- got no reply is not merely un-chased; they are waiting.
--
-- Stored on insights_cache rather than as a scheduled_calls row with a null
-- time, because it is not a call. It is a fact about the conversation — the
-- same kind of thing as last_inbound_at — and giving it a row in the calls
-- table would mean every query there has to remember that some "calls" have no
-- time.
-- =============================================================================

alter table insights_cache
  add column if not exists wants_call_at timestamptz;

alter table insights_cache
  add column if not exists wants_call_quote text;

-- Set when Eddie has seen it and decided not to book. Distinct from clearing
-- the signal, which is what booking does: dismissed means "asked and answered",
-- and a later request from the same lead should surface again.
alter table insights_cache
  add column if not exists wants_call_dismissed_at timestamptz;

comment on column insights_cache.wants_call_at is
  'When a lead last asked to talk without naming a time. Cleared when a call '
  'is actually booked for them — the request has been answered by then.';

-- The Today query: outstanding requests, newest first.
create index if not exists idx_insights_cache_wants_call
  on insights_cache (user_id, wants_call_at desc)
  where wants_call_at is not null and wants_call_dismissed_at is null;
