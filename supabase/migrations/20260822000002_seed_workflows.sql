-- =============================================================================
-- Phase 7 section 4.6 — the two seed workflows, both in dry-run.
--
-- Eddie described a 2-day rule; the campaign document showed it needs a
-- companion. His Bonzo campaigns are a state machine and a prospect sits in
-- exactly one, so a lead being worked by LeadTracker has to be parked
-- somewhere that is not still drip-messaging them:
--
--   priority 10  — on entering Quoted – Follow Up, move to
--                  "No Drip, Responded, Appointment Set" [122735].
--                  Bonzo stops dripping; LeadTracker owns the follow-up.
--                  Without this a lead gets a LeadTracker card AND a Bonzo
--                  drip the same afternoon — two touches, uncoordinated,
--                  which reads as automated. That is the thing this whole
--                  phase exists to avoid.
--
--   priority 100 — after 2 days with no reply, move to
--                  "Quoted - Auto Follow up" [43998], which has a live
--                  sequence. Bonzo takes the long game back.
--
-- Priority order matters because the first match wins. The park must beat the
-- handoff on the evaluation where a lead has just entered the stage.
--
-- Both are created enabled=false and dry_run=true. 4.4 makes dry-run
-- non-optional for anything new, and Eddie has said he will watch them for
-- several days before enabling. Turning them on is two clicks on /workflows;
-- nothing here starts messaging anyone.
--
-- Campaign IDs are Eddie's real ones, confirmed against the live API. If a
-- campaign is deleted in Bonzo the workflow will fail loudly at execution
-- rather than acting on a stale id — which is the right failure.
--
-- Idempotent: guarded on (user_id, name), so re-running changes nothing and
-- will not resurrect a workflow that was deliberately deleted... it will, in
-- fact, recreate a deleted one. That is accepted: this runs on migration, not
-- on a schedule, and a recreated workflow arrives switched off.
-- =============================================================================

insert into workflows (
  user_id, name, enabled, dry_run,
  trigger_type, trigger_config, conditions,
  action_type, action_config,
  requires_approval, priority
)
select
  u.user_id,
  'Park in No Drip while I work them',
  false,
  true,
  'stage_changed',
  jsonb_build_object('stage', 'quoted_follow_up', 'direction', 'into'),
  '{}'::jsonb,
  'add_to_bonzo_campaign',
  jsonb_build_object('campaign_id', 122735),
  true,
  10
from user_settings u
where not exists (
  select 1 from workflows w
   where w.user_id = u.user_id
     and w.name = 'Park in No Drip while I work them'
);

insert into workflows (
  user_id, name, enabled, dry_run,
  trigger_type, trigger_config, conditions,
  action_type, action_config,
  requires_approval, priority
)
select
  u.user_id,
  'Hand off after 2 quiet days',
  false,
  true,
  'no_inbound_since',
  jsonb_build_object('days', 2),
  -- The stage condition is belt and braces: QUEUE_ELIGIBLE_STAGES already
  -- bars every other stage from evaluation, but naming it here means the rule
  -- still reads correctly if that constant ever moves again.
  jsonb_build_object('stage', jsonb_build_array('quoted_follow_up')),
  'add_to_bonzo_campaign',
  jsonb_build_object('campaign_id', 43998),
  true,
  100
from user_settings u
where not exists (
  select 1 from workflows w
   where w.user_id = u.user_id
     and w.name = 'Hand off after 2 quiet days'
);
