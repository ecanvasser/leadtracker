-- =============================================================================
-- Contact agents — a per-lead follow-up plan, deployed by hand.
--
-- This deliberately crosses a Phase 8 non-goal: "Drafting is scoped to one
-- window only. Do not extend it to Hot Lead, Needs Quote, or anything
-- post-handoff." That rule exists because the Phase 7 system drafted cold
-- outreach from almost nothing and filled the vacuum with enthusiasm.
--
-- What removes that reason here is `context`, which is NOT NULL and rejected
-- empty at the API. An agent is never deployed ambiently: Eddie opens a lead,
-- writes what he knows, and presses a button. The failure mode the non-goal
-- was written against — a model writing to someone it knows nothing about —
-- cannot occur when the brief is a required input.
--
-- Everything else stays where it already is. An agent does not send; it
-- proposes a touch through the same daily_queue row and the same Telegram
-- approval card that the quoted-window drafts use, with the same validator and
-- the same budget gate.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- The agent itself
-- ---------------------------------------------------------------------------
create table if not exists contact_agents (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,

  -- draft     — plan built, shown to Eddie, not yet acting
  -- active    — touches are being scheduled
  -- paused    — stopped for a reason worth reading; resumable
  -- completed — every step ran
  -- retired   — ended deliberately, or the lead left the pipeline
  status text not null default 'draft' check (
    status in ('draft', 'active', 'paused', 'completed', 'retired')
  ),

  /*
   * Eddie's brief. Required — see the header. The whole safety argument for
   * this feature rests on it existing, so it is NOT NULL here as well as
   * validated at the API: a row inserted any other way must still carry one.
   */
  context text not null check (length(trim(context)) > 0),

  -- What he is trying to get to happen. Shapes the plan and is quoted back on
  -- the completion note.
  goal text not null check (length(trim(goal)) > 0),

  -- The built plan: { summary, steps: [{ step, day, hypothesis, angle, rationale }] }.
  plan jsonb not null default '{}'::jsonb,

  duration_days integer not null default 14 check (duration_days between 1 and 90),

  /*
   * Why an agent stopped, in Eddie's words rather than a status code. A paused
   * agent with no reason is the Waiting-list-without-reasons problem from
   * section 1.3 all over again.
   */
  paused_reason text,

  created_at   timestamptz not null default now(),
  activated_at timestamptz,
  ended_at     timestamptz,
  updated_at   timestamptz not null default now()
);

/*
 * One live agent per contact.
 *
 * Two agents on the same lead would draft two different follow-ups from two
 * different briefs and push both to the phone, which is the uncoordinated
 * second touch this whole phase exists to avoid — only now self-inflicted.
 * Partial, so a lead can be re-deployed after one finishes.
 */
create unique index if not exists idx_contact_agents_one_live
  on contact_agents (contact_id)
  where status in ('draft', 'active', 'paused');

create index if not exists idx_contact_agents_user_status
  on contact_agents (user_id, status);

-- ---------------------------------------------------------------------------
-- One row per planned touch
--
-- The plan lives in jsonb because it is written once and read whole. Execution
-- does not: "which touch is due" is a query the tick runs every five minutes,
-- and it must not mean parsing a document per agent. Rows also give the
-- history — what was proposed, what Eddie did with it — which the plan alone
-- could never record.
-- ---------------------------------------------------------------------------
create table if not exists contact_agent_touches (
  id         uuid primary key default gen_random_uuid(),
  agent_id   uuid not null references contact_agents(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,

  step_index integer not null,
  due_at     timestamptz not null,

  -- pending   — scheduled, not yet drafted
  -- drafted   — a card exists and is awaiting Eddie
  -- sent      — he approved it
  -- skipped   — he dismissed it, or a guard cancelled it
  -- cancelled — the agent stopped before this step ran
  status text not null default 'pending' check (
    status in ('pending', 'drafted', 'sent', 'skipped', 'cancelled')
  ),

  -- The daily_queue row carrying the draft, once one exists.
  queue_item_id uuid references daily_queue(id) on delete set null,

  -- Why a guard cancelled or deferred it, for the agent's history panel.
  note text,

  drafted_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz not null default now()
);

-- A step runs once. The tick is every five minutes and a retried job must not
-- create a second touch for the same step.
create unique index if not exists idx_agent_touches_step
  on contact_agent_touches (agent_id, step_index);

-- The scheduler's query: touches that are due and have not been acted on.
create index if not exists idx_agent_touches_due
  on contact_agent_touches (due_at)
  where status = 'pending';

create index if not exists idx_agent_touches_contact
  on contact_agent_touches (contact_id, due_at desc);

-- ---------------------------------------------------------------------------
-- Which queue rows belong to an agent
--
-- The Telegram card and the queue page both need to know an item came from an
-- agent, to label it and to route Skip back to the right touch. A column
-- rather than a priority_reason string match, because that is how the
-- inbound-reply lane already went wrong once.
-- ---------------------------------------------------------------------------
alter table daily_queue
  add column if not exists agent_touch_id uuid references contact_agent_touches(id) on delete set null;

create index if not exists idx_daily_queue_agent_touch
  on daily_queue (agent_touch_id)
  where agent_touch_id is not null;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table contact_agents        enable row level security;
alter table contact_agent_touches enable row level security;

drop policy if exists "own_contact_agents" on contact_agents;
create policy "own_contact_agents" on contact_agents
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Touches are written by the worker under the service role. The browser reads
-- them for the history panel and never writes: a client that could invent a
-- touch could schedule a message to a client.
drop policy if exists "own_agent_touches_read" on contact_agent_touches;
create policy "own_agent_touches_read" on contact_agent_touches
  for select using (auth.uid() = user_id);

drop trigger if exists contact_agents_updated_at on contact_agents;
create trigger contact_agents_updated_at before update on contact_agents
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Job type
-- ---------------------------------------------------------------------------
alter table jobs drop constraint if exists jobs_job_type_check;
alter table jobs add constraint jobs_job_type_check check (
  job_type in (
    'refresh_cache', 'generate_queue_item', 'send_message', 'classify_lead',
    'draft_reply', 'extract_call_time', 'morning_digest', 'draft_quoted',
    'evaluate_workflows',
    -- Drafts one agent touch. Costs a model call, so it is gated by the same
    -- budget and the same guards as draft_quoted.
    'agent_touch'
  )
);
