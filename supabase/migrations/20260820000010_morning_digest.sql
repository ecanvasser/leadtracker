-- =============================================================================
-- 2.3 — Morning digest
-- =============================================================================

-- Widen the job_type check to allow the digest.
--
-- Drop-and-add rather than a new constraint so there is exactly one definition
-- to read. This only ever widens the allowed set, so every existing row still
-- satisfies it and the revalidation cannot fail.
alter table jobs drop constraint if exists jobs_job_type_check;
alter table jobs add constraint jobs_job_type_check check (
  job_type in (
    'refresh_cache',
    'generate_queue_item',
    'send_message',
    'classify_lead',
    'draft_reply',
    'extract_call_time',
    'morning_digest'
  )
);

-- The local date the digest last went out, so it fires once a day regardless
-- of how many ticks fall inside the digest window. A date rather than a
-- timestamp because "did today's digest go out" is a local-calendar question.
alter table user_settings
  add column if not exists last_digest_date date;
