-- =============================================================================
-- Phase 8 section 6A — drafting in the quoted window.
--
-- Reintroduces drafting, narrowly. Everything here is off by default: the
-- feature ships behind drafting_mode = 'off' and cannot generate a single
-- token until that is changed deliberately.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- The trust ladder, applied to drafting.
--
-- The same three states the workflow rules use, for the same reason: Eddie
-- will not hand client messaging to something he has not watched. Section 9 is
-- explicit that step 8 ships in dry run — "I want to see a few drafts I'd have
-- sent before any of them can actually send" — and reusing the vocabulary he
-- already knows is better than inventing a second one that means the same
-- thing.
--
--   off     — no drafting job is ever enqueued. No tokens spent.
--   dry_run — drafts are generated and pushed to Telegram to be read, with no
--             Send button on the card. Nothing can leave.
--   live    — the card carries Send, and Send still asks him first by being a
--             button he has to press. Nothing sends on its own, ever.
-- ---------------------------------------------------------------------------
alter table user_settings
  add column if not exists drafting_mode text not null default 'off';

do $$ begin
  alter table user_settings add constraint user_settings_drafting_mode_valid
    check (drafting_mode in ('off', 'dry_run', 'live'));
exception when duplicate_object then null;
end $$;

comment on column user_settings.drafting_mode is
  'off | dry_run | live. Gates quoted-window drafting entirely. Ships off; '
  'dry_run generates drafts with no Send button so they can be read before '
  'any can be sent.';

-- ---------------------------------------------------------------------------
-- D5 — the schedule, in settings rather than in code.
--
-- One draft about three hours after the quote if there has been no reply, and
-- one at twenty-four hours if it is still silent. Day two is the handoff
-- decision, not a third draft.
--
-- Stored as hours-since-pitch rather than as a cadence, because that is what
-- the window actually is: the clock starts when the lead enters Quoted –
-- Follow Up and stops when the handoff rule fires.
-- ---------------------------------------------------------------------------
alter table user_settings
  add column if not exists draft_schedule_hours integer[] not null default '{3,24}';

comment on column user_settings.draft_schedule_hours is
  'Hours after entering Quoted - Follow Up at which a draft is offered, if the '
  'lead is still silent. D5: 3 and 24, with 48 being the handoff decision '
  'rather than a third draft.';

-- ---------------------------------------------------------------------------
-- 6A.6 — the redraft cap.
--
-- A redraft loop is the obvious runaway cost risk in this feature: every
-- "shorter" is another call, and nothing about the loop is self-limiting.
-- The daily token budget would eventually catch it, but only after the money
-- is spent and by shutting off everything else too.
-- ---------------------------------------------------------------------------
alter table user_settings
  add column if not exists max_redrafts_per_day integer not null default 3;

do $$ begin
  alter table user_settings add constraint user_settings_max_redrafts_sane
    check (max_redrafts_per_day between 0 and 20);
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- 6A.5 — capture the edits.
--
-- When Eddie uses Edit, both the draft and what he actually sent are stored on
-- the same row. Nothing acts on this yet and nothing should: the point is to
-- collect the diffs, so that if the drafts need heavy editing again there is
-- evidence for what is wrong rather than a second round of guessing.
--
-- On outreach_log rather than daily_queue because the log row is the record of
-- what was sent, and a queue row can be deleted or regenerated.
-- ---------------------------------------------------------------------------
alter table outreach_log
  add column if not exists original_draft text;

comment on column outreach_log.original_draft is
  'What the model wrote, when draft_message holds what Eddie actually sent '
  'after editing. Null when the two are the same. 6A.5: collected as evidence '
  'for improving the prompt, never acted on automatically.';

-- ---------------------------------------------------------------------------
-- Drafts that failed validation twice are shown anyway, flagged (6A.3).
-- The approval card has rendered these since Phase 7; nothing has written the
-- column because the validator that produced them was retired.
-- ---------------------------------------------------------------------------
alter table daily_queue
  add column if not exists unvalidated_reasons jsonb;

comment on column daily_queue.unvalidated_reasons is
  'Violations a surfaced draft still carries after its one corrective retry. '
  'Null means the draft passed. Never a reason to hide the draft — 6A.3 says '
  'surface it flagged rather than loop.';

-- Finding the day's drafts for a lead, for the per-day and per-lead caps.
create index if not exists idx_outreach_log_contact_action_created
  on outreach_log (contact_id, action_type, created_at desc);

-- ---------------------------------------------------------------------------
-- The job type.
--
-- Drop-and-add rather than a new constraint so there is exactly one definition
-- to read, following 20260820000010. This only ever widens the allowed set, so
-- every existing row still satisfies it and the revalidation cannot fail.
--
-- 'draft_reply' stays in the list despite being a Phase 7 misnomer that no
-- longer drafts anything: live rows in the queue and pg_cron still carry it,
-- and renaming it is a separate change from adding this one.
-- ---------------------------------------------------------------------------
alter table jobs drop constraint if exists jobs_job_type_check;
alter table jobs add constraint jobs_job_type_check check (
  job_type in (
    'refresh_cache',
    'generate_queue_item',
    'send_message',
    'classify_lead',
    'draft_reply',
    'extract_call_time',
    'morning_digest',
    'draft_quoted'
  )
);
