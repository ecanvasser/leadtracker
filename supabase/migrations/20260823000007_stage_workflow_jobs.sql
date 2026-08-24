-- =============================================================================
-- Make the stage_changed trigger actually able to fire.
--
-- It never could. Two independent faults, both of which had to be true for
-- the rule to do nothing, and both of which were:
--
--   1. Workflow evaluation ran only inside refresh_cache, which passes
--      `previousStage: null`. matchTrigger('stage_changed') returns NO_MATCH
--      the moment previousStage is absent — "not a stage-change evaluation" —
--      so the rule was structurally incapable of matching from that path.
--
--   2. Evaluation sits below refresh_cache's "no new messages" early return.
--      Moving a lead's stage in LeadTracker does not create a Bonzo message,
--      so a stage change on its own never reached the evaluation block at all.
--
-- Confirmed against production before writing this: a lead moved to Quoted –
-- Follow Up at 16:03, the sweep synced them at 16:15, and workflow_runs held
-- zero rows. The sweep was working exactly as designed and there was nothing
-- at the end of it.
--
-- The fix uses the seam that already exists. stage_transitions is written by
-- a database trigger, so it sees every path a stage can change through — a
-- board drag, the contact page, a Today row, a workflow action, a hand-edit
-- in the SQL editor. Anything that can enqueue from there inherits the same
-- coverage for free, and nothing has to remember to call it.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The new job type.
-- ---------------------------------------------------------------------------
alter table jobs drop constraint if exists jobs_job_type_check;

alter table jobs add constraint jobs_job_type_check check (
  job_type in (
    'refresh_cache', 'generate_queue_item', 'send_message', 'classify_lead',
    'draft_reply', 'extract_call_time', 'morning_digest', 'draft_quoted',
    -- Evaluates the rules for one lead against facts already in the cache.
    -- No Bonzo call, no model call, no cost.
    'evaluate_workflows'
  )
);

-- ---------------------------------------------------------------------------
-- 2. Enqueue on a genuine stage change.
--
-- Its own trigger rather than a second job bolted onto log_stage_transition.
-- That function's own header argues for one responsibility per trigger, and
-- writing history and scheduling work are different enough that a future
-- change to either should not have to reason about both.
--
-- Deliberately NOT fired on INSERT. A lead created directly in Quoted –
-- Follow Up has no previous stage, matchTrigger requires one, and the seed
-- workflow tests assert that a fresh lead is never handed straight to a
-- campaign on arrival. Enqueueing there would burn a job to reach the same
-- no-match every time a contact is created.
--
-- SECURITY DEFINER for the same reason log_stage_transition needs it: the
-- board writes stage changes straight from the browser as the authenticated
-- user, and under invoker rights the insert would be checked against the jobs
-- table's RLS policies. A client that cannot enqueue would move the lead and
-- silently skip the rules.
--
-- `on conflict do nothing` is load-bearing. idx_jobs_outstanding_unique
-- allows one outstanding job per (user, type, contact), so a lead moved twice
-- inside one drain window coalesces to a single evaluation rather than
-- erroring the second UPDATE — and erroring here would roll back the stage
-- change itself, which is the last thing a rule should be able to do.
-- ---------------------------------------------------------------------------
create or replace function enqueue_stage_workflows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.stage is distinct from old.stage then
    insert into public.jobs (user_id, contact_id, job_type, payload)
    values (new.user_id, new.id, 'evaluate_workflows',
            jsonb_build_object('triggered_by', 'stage_changed'))
    on conflict do nothing;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_contacts_enqueue_stage_workflows on contacts;

create trigger trg_contacts_enqueue_stage_workflows
  after update on contacts
  for each row
  execute function enqueue_stage_workflows();

-- ---------------------------------------------------------------------------
-- 3. Hold off while a conversation is still warm.
--
-- The drafting schedule counted from the quote. It should count from the last
-- thing anyone said: a lead quoted at 9am and messaged again at 2pm has had a
-- touch at 2pm, and a draft three hours after the quote would land on top of
-- it. Below this many hours since the last message, in either direction,
-- nothing is due.
-- ---------------------------------------------------------------------------
alter table user_settings
  add column if not exists min_hours_since_last_message integer not null default 6;

comment on column user_settings.min_hours_since_last_message is
  'Hours of quiet required before a quoted-window draft is due. Measured from '
  'the last message in either direction, so Eddie sending something resets it.';
