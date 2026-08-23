-- =============================================================================
-- Phase 7 section 4 — the workflow builder's storage.
--
-- Eddie configures rules; the app evaluates them. This file is storage and
-- guardrails only: step 4 of the rollout wires evaluation and dry-run, and no
-- action is executed yet.
--
-- Idempotent and forward-only, like everything else here. No enum types are
-- created for trigger_type / action_type / status — they are text with check
-- constraints, deliberately. Adding a trigger to an enum would need its own
-- migration file and a second one to use it (see 20260821000001); a check
-- constraint can be replaced in place, and this is a list that will grow.
-- =============================================================================

create table if not exists workflows (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,

  -- Three states, not two. `enabled` is the spec's column and the off switch;
  -- `dry_run` decides whether a fired workflow acts or only records what it
  -- would have done.
  --
  --   enabled=false                -> off
  --   enabled=true,  dry_run=true  -> dry-run (the default for anything new)
  --   enabled=true,  dry_run=false -> live
  --
  -- Both defaults are deliberately the timid ones: a workflow created by any
  -- path, including a seed or a future import, is off until Eddie turns it on
  -- and cannot act until he turns dry_run off separately. 4.4 calls dry-run
  -- non-optional and this is where that is enforced.
  enabled     boolean not null default false,
  dry_run     boolean not null default true,

  trigger_type   text  not null,
  trigger_config jsonb not null default '{}'::jsonb,

  -- Optional filters: loan_type, stage, amount range.
  conditions     jsonb not null default '{}'::jsonb,

  action_type    text  not null,
  action_config  jsonb not null default '{}'::jsonb,

  -- 4.4: a campaign handoff starts real messaging under Eddie's name. D2 makes
  -- this a per-workflow setting defaulting to approval-required.
  requires_approval boolean not null default true,

  -- Lower evaluates first. 4.4: workflows evaluate in priority order and the
  -- first match wins, so a quiet lead cannot land in three campaigns.
  priority    integer not null default 100,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint workflows_trigger_type_check check (trigger_type in (
    'days_in_stage',
    'no_inbound_since',
    'no_outbound_since',
    'inbound_received',
    'classification_match',
    'stage_changed'
  )),

  constraint workflows_action_type_check check (action_type in (
    'add_to_bonzo_campaign',
    'move_stage',
    'notify_telegram',
    'create_task',
    'queue_follow_up',
    'mark_adverse'
  ))
);

alter table workflows add column if not exists dry_run boolean not null default true;

-- Evaluation reads every enabled workflow for a user in priority order.
create index if not exists workflows_user_priority_idx
  on workflows (user_id, priority)
  where enabled;

create table if not exists workflow_runs (
  id          uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references workflows(id) on delete cascade,
  contact_id  uuid not null references contacts(id) on delete cascade,
  fired_at    timestamptz not null default now(),

  status text not null,

  -- Why it fired, for auditing. Includes the facts the decision was made from,
  -- so a surprising run can be read back weeks later without re-deriving it.
  trigger_snapshot jsonb not null default '{}'::jsonb,

  -- What the action displaced, so it can be put back. Bonzo campaign
  -- enrollment REPLACES rather than appends (proven by live probe), which is
  -- what Eddie wants — moving campaigns is how his pipeline advances. But it
  -- means a wrong move loses the previous campaign unless it is recorded here.
  -- Reversal is one API call with the id stored in this column.
  displaced jsonb,

  error text,

  -- Set when an approval card was pushed, so the card can be edited in place
  -- once Eddie answers rather than leaving a live Send button on screen.
  telegram_message_id bigint,

  /*
   * 4.4 idempotency: "a given workflow fires at most once per contact per
   * trigger occurrence".
   *
   * "Occurrence" needs a concrete identity or the rule cannot be enforced —
   * a no_inbound_since rule would otherwise re-fire every evaluation for the
   * same quiet spell. Each trigger derives a stable key for the occasion it
   * fired on: the stage entry timestamp for days_in_stage and stage_changed,
   * the last inbound timestamp for no_inbound_since and inbound_received, the
   * classification timestamp for classification_match.
   *
   * The unique index below is the actual guard. Checking workflow_runs before
   * acting is the fast path; this is what holds when two evaluations race.
   */
  occurrence_key text not null,

  constraint workflow_runs_status_check check (status in (
    'pending_approval',
    'executed',
    'skipped',
    'failed',
    'dry_run'
  ))
);

alter table workflow_runs add column if not exists displaced jsonb;
alter table workflow_runs add column if not exists telegram_message_id bigint;

create unique index if not exists workflow_runs_occurrence_uniq
  on workflow_runs (workflow_id, contact_id, occurrence_key);

create index if not exists workflow_runs_workflow_fired_idx
  on workflow_runs (workflow_id, fired_at desc);

create index if not exists workflow_runs_contact_idx
  on workflow_runs (contact_id, fired_at desc);

-- 4.4 kill switch. Defaults to true because every individual workflow already
-- defaults to off and to dry-run; this is the panic lever, not the safety.
alter table user_settings
  add column if not exists workflows_enabled boolean not null default true;

comment on column user_settings.workflows_enabled is
  'Global halt for all workflow evaluation. Reachable from Telegram via '
  '/pause. Individual workflows default to off and to dry-run; this stops '
  'everything at once regardless of those.';

-- ---------------------------------------------------------------------------
-- RLS, matching the pattern used by every other table here.
-- ---------------------------------------------------------------------------

alter table workflows     enable row level security;
alter table workflow_runs enable row level security;

drop policy if exists "Users can view own workflows"   on workflows;
drop policy if exists "Users can insert own workflows" on workflows;
drop policy if exists "Users can update own workflows" on workflows;
drop policy if exists "Users can delete own workflows" on workflows;

create policy "Users can view own workflows"   on workflows for select using (auth.uid() = user_id);
create policy "Users can insert own workflows" on workflows for insert with check (auth.uid() = user_id);
create policy "Users can update own workflows" on workflows for update using (auth.uid() = user_id);
create policy "Users can delete own workflows" on workflows for delete using (auth.uid() = user_id);

-- workflow_runs has no user_id of its own; ownership comes from its workflow.
drop policy if exists "Users can view own workflow runs" on workflow_runs;

create policy "Users can view own workflow runs" on workflow_runs for select using (
  exists (
    select 1 from workflows w
     where w.id = workflow_runs.workflow_id
       and w.user_id = auth.uid()
  )
);
