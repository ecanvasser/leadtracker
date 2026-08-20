-- =============================================================================
-- 2.5 — Email subject as its own column
--
-- Drafting stored an email as "Subject: X\n\nBody" inside draft_message, and
-- the queue UI stripped that prefix for display. Anything that sent the stored
-- text unedited put the literal "Subject: ..." line into the message body.
--
-- Bonzo's POST /v3/prospects/{prospect}/email requires `subject` and `message`
-- as separate fields, so there was never a reason to pack them together.
-- =============================================================================

alter table daily_queue add column if not exists email_subject text;

-- outreach_log records what was actually sent, so it needs the same split to
-- stay an accurate record.
alter table outreach_log add column if not exists email_subject text;

-- The Bonzo message id returned on a successful send. Without it there is no
-- way to tie a row here back to the message in Bonzo when reconciling.
alter table outreach_log add column if not exists provider_message_id text;

-- ---------------------------------------------------------------------------
-- Backfill: split any existing "Subject: X\n\nBody" rows.
--
-- Only touches rows that actually carry the prefix, and only where the subject
-- column is still empty, so re-running cannot double-apply.
-- ---------------------------------------------------------------------------
update daily_queue
set email_subject = substring(draft_message from '^Subject: (.*?)(?:\r?\n)'),
    draft_message = regexp_replace(draft_message, '^Subject: .*?(?:\r?\n){2}', '')
where action_type = 'email'
  and email_subject is null
  and draft_message like 'Subject: %';

update outreach_log
set email_subject = substring(draft_message from '^Subject: (.*?)(?:\r?\n)'),
    draft_message = regexp_replace(draft_message, '^Subject: .*?(?:\r?\n){2}', '')
where action_type = 'email'
  and email_subject is null
  and draft_message like 'Subject: %';
