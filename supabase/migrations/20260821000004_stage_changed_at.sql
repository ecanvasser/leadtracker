-- =============================================================================
-- contacts.stage_changed_at — when the lead entered its current stage.
--
-- Two things need this and neither can be answered today:
--
--   1. days_since_pitch on the follow-up card (spec 3.1). A lead in Quoted –
--      Follow Up has been pitched; how long ago is the single most useful fact
--      on the card, and nothing records it. updated_at moves on any edit, so
--      it cannot stand in.
--
--   2. The `days_in_stage` workflow trigger (spec 4.2), which is meaningless
--      without a stage-entry timestamp.
--
-- Backfilled from updated_at rather than left null. That is wrong for any row
-- edited since its last stage change, but it is wrong in the safe direction:
-- updated_at is never earlier than the stage change, so a backfilled lead
-- looks NEWER than it is and a time-based handoff fires late rather than
-- early. Firing early would hand a live lead to a cold campaign.
--
-- The trigger keeps it accurate from here on, so the backfill's error decays
-- to nothing as leads move.
-- =============================================================================

alter table contacts
  add column if not exists stage_changed_at timestamptz;

update contacts
   set stage_changed_at = coalesce(updated_at, created_at)
 where stage_changed_at is null;

alter table contacts
  alter column stage_changed_at set default now();

comment on column contacts.stage_changed_at is
  'When the contact entered its current stage. Maintained by '
  'trg_contacts_stage_changed_at. Rows predating this column were backfilled '
  'from updated_at, which over-estimates recency — deliberately, so time-based '
  'workflows fire late rather than early.';

create or replace function set_stage_changed_at()
returns trigger
language plpgsql
as $$
begin
  -- Only a genuine stage change moves the clock. Assigning the same stage
  -- again — which a drag that lands back in its own column does — must not
  -- reset a lead's age and hide it from a days_in_stage trigger.
  if tg_op = 'INSERT' then
    new.stage_changed_at := coalesce(new.stage_changed_at, now());
  elsif new.stage is distinct from old.stage then
    new.stage_changed_at := now();
  else
    new.stage_changed_at := old.stage_changed_at;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_contacts_stage_changed_at on contacts;

create trigger trg_contacts_stage_changed_at
  before insert or update on contacts
  for each row
  execute function set_stage_changed_at();
