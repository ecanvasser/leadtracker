-- =============================================================================
-- Calls: scan on arrival, and book one by hand.
--
-- The detector, the timezone resolution, the confirmation card and the
-- T-15/T-0/outcome reminders were all built in Phase 3 and all work. They have
-- simply never been fed: scanForCallCommitments is called from one place, deep
-- inside refresh_cache's model-work branch, which is gated on
-- isQueueEligible(stage) — Quoted – Follow Up and nothing else.
--
-- Eddie's call requests arrive earlier than that. A lead texts "call me at
-- noon tomorrow" in Bonzo, he adds them to the app as a Hot Lead, and the
-- scanner never looks. One call detected across twenty-one active leads.
--
-- Two changes here support the fix in code:
--   1. A scan_calls job type, so the whole history can be read the moment a
--      lead is linked rather than waiting for a stage it may never reach.
--   2. `source` on scheduled_calls, so a call booked by hand is distinguishable
--      from one the detector found. They need different trust: a detected time
--      is a reading of someone's words and is always confirmed before it
--      counts, while one Eddie typed is already confirmed by definition.
-- =============================================================================

alter table jobs drop constraint if exists jobs_job_type_check;
alter table jobs add constraint jobs_job_type_check check (
  job_type in (
    'refresh_cache', 'generate_queue_item', 'send_message', 'classify_lead',
    'draft_reply', 'extract_call_time', 'morning_digest', 'draft_quoted',
    'evaluate_workflows', 'agent_touch',
    -- Reads a lead's whole conversation looking for a call commitment.
    -- Pattern-first, so a history with no call-shaped wording costs nothing.
    'scan_calls'
  )
);

-- ---------------------------------------------------------------------------
-- Where the call came from
--
-- 'detected'  — read out of the conversation; needs confirming.
-- 'manual'    — Eddie booked it; already true.
--
-- Defaulted to 'detected' so existing rows keep their meaning: every call in
-- the table today came from the scanner.
-- ---------------------------------------------------------------------------
alter table scheduled_calls
  add column if not exists source text not null default 'detected';

do $$ begin
  alter table scheduled_calls add constraint scheduled_calls_source_valid
    check (source in ('detected', 'manual'));
exception when duplicate_object then null;
end $$;

-- A manual booking has no message behind it, so the quote cannot be required.
alter table scheduled_calls alter column source_quote drop not null;

comment on column scheduled_calls.source_quote is
  'The words the call time was read out of. Null for a manual booking, where '
  'there is no message to quote — the note column carries Eddie''s own reason.';

-- What the call is for, in his words. Shown on the reminder so a call he
-- booked four days ago still makes sense when the phone buzzes.
alter table scheduled_calls
  add column if not exists note text;

-- ---------------------------------------------------------------------------
-- The Today query: every call in a local day window, soonest first.
-- ---------------------------------------------------------------------------
create index if not exists idx_scheduled_calls_user_day
  on scheduled_calls (user_id, scheduled_at)
  where status in ('proposed', 'confirmed');

-- ---------------------------------------------------------------------------
-- Watermark for the full-history scan
--
-- insights_cache.calls_scanned_through already exists and already means "we
-- have read up to here". Nothing new is needed; this comment records that the
-- scan-on-link job deliberately leaves it null on a first pass so the entire
-- history is read, which is the whole point of that job.
-- ---------------------------------------------------------------------------
comment on column insights_cache.calls_scanned_through is
  'Newest message already examined for a call commitment. Null means nothing '
  'has been read, which makes the next scan cover the full history — the '
  'behaviour scan_calls relies on when a lead is first linked.';
