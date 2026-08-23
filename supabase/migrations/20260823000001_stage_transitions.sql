-- =============================================================================
-- Phase 8 section 4.1 — stage_transitions
--
-- contacts.stage_changed_at holds only the *current* stage entry, so the
-- moment a lead moves again the previous entry is gone. That makes the one
-- number Eddie believes matters most — median hours from Needs Quote to
-- Quoted — permanently unrecoverable from the data the app keeps today.
--
-- Forward-only. No backfill is possible and none should be attempted: there
-- is no record anywhere of when a lead entered a stage it has since left, and
-- a fabricated history would make the median look precise while being wrong.
-- The table starts empty and is meaningful once leads have moved through it,
-- which is why this lands early in the phase rather than alongside the screen
-- that reads it.
-- =============================================================================

create table if not exists stage_transitions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,

  -- Null on insert: a lead arriving in the pipeline came from nowhere. That
  -- is a real transition worth logging, not a missing one — a lead created
  -- directly in Needs Quote starts its speed-to-quote clock here.
  from_stage pipeline_stage,
  to_stage   pipeline_stage not null,

  changed_at timestamptz not null default now()
);

-- The speed-to-quote query: every arrival in a given stage for one user,
-- within a date window. Leading with to_stage because it is the selective
-- term — two stages out of eight.
create index if not exists idx_stage_transitions_user_to_stage
  on stage_transitions (user_id, to_stage, changed_at desc);

-- Pairing an entry with the exit that follows it is per-contact and ordered.
create index if not exists idx_stage_transitions_contact
  on stage_transitions (contact_id, changed_at);

-- ---------------------------------------------------------------------------
-- The trigger
--
-- AFTER rather than BEFORE, and separate from set_stage_changed_at, for two
-- reasons. A BEFORE trigger fires while the row can still be cancelled or
-- rewritten by another BEFORE trigger, so a log written there can disagree
-- with what was actually stored. And set_stage_changed_at is deliberately a
-- pure field-setter with no side effects; giving it a second job means every
-- future change to either behaviour has to reason about both.
--
-- Both fire on the same events and share the same "only a genuine change
-- counts" test, so the guarantee section 4.1 asks for is intact: this is
-- driven by the database, which is what makes it capture a drag-and-drop, an
-- edit from the contact page, a Today row, a workflow action, and anything
-- written directly in the SQL editor. Nothing has to remember to call it.
--
-- SECURITY DEFINER because the board writes stage changes straight from the
-- browser as the authenticated user. Under invoker rights the insert would be
-- checked against this table's RLS policies, and a client that cannot write
-- the log could silently move a lead without recording it. A log that can be
-- defeated by the thing it is auditing is not a log. The empty search_path is
-- the standard precaution that goes with definer rights — every name below is
-- schema-qualified because of it.
-- ---------------------------------------------------------------------------
create or replace function log_stage_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.stage_transitions (user_id, contact_id, from_stage, to_stage, changed_at)
    values (new.user_id, new.id, null, new.stage, coalesce(new.stage_changed_at, now()));
  elsif new.stage is distinct from old.stage then
    -- Same test as set_stage_changed_at: re-assigning the same stage, which a
    -- drag landing back in its own column does, is not a transition and must
    -- not appear in the history as one.
    insert into public.stage_transitions (user_id, contact_id, from_stage, to_stage, changed_at)
    values (new.user_id, new.id, old.stage, new.stage, coalesce(new.stage_changed_at, now()));
  end if;
  return null;  -- AFTER trigger: the return value is ignored.
end;
$$;

drop trigger if exists trg_contacts_log_stage_transition on contacts;

create trigger trg_contacts_log_stage_transition
  after insert or update on contacts
  for each row
  execute function log_stage_transition();

-- ---------------------------------------------------------------------------
-- RLS
--
-- Read-own only. There is deliberately no insert, update or delete policy:
-- the definer trigger above is the only writer, and an append-only history is
-- the entire point. A client that could rewrite it could rewrite the number
-- it produces.
-- ---------------------------------------------------------------------------
alter table stage_transitions enable row level security;

drop policy if exists "own_stage_transitions_select" on stage_transitions;
create policy "own_stage_transitions_select" on stage_transitions
  for select using (auth.uid() = user_id);

comment on table stage_transitions is
  'Append-only stage history, written by trg_contacts_log_stage_transition. '
  'Forward-only from Phase 8: rows predating the trigger do not and cannot '
  'exist. Read by the speed-to-quote number on /today.';
