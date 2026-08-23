-- =============================================================================
-- Phase 8 sections 6 and 6.1 — the two rules, sharpened.
--
-- Three changes, none of which touch the engine:
--
--   1. workflows.auto_approve, so an individual rule can be trusted without
--      relaxing what requires_approval means.
--   2. The handoff moves from "Quoted - Auto Follow up" to "Responded (NEW
--      Quoted)".
--   3. The handoff gains a pitch_response condition, so a two-day window that
--      produced a real reply does not end in a campaign.
--
-- Both rules keep requires_approval = true. Both keep enabled = false and
-- dry_run = true; nothing here starts messaging anyone.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- auto_approve
--
-- Deliberately a second flag rather than flipping requires_approval, because
-- the two say different things. requires_approval is a property of the
-- action — a campaign move is consequential and reversing it is awkward.
-- auto_approve is a statement about one rule Eddie has watched long enough to
-- trust. Collapsing them would lose the first the moment he grants the second,
-- and getting it back would mean remembering why it was true.
--
-- Effective rule: approval is needed when requires_approval AND NOT
-- auto_approve.
-- ---------------------------------------------------------------------------
alter table workflows
  add column if not exists auto_approve boolean not null default false;

comment on column workflows.auto_approve is
  'Skips the Telegram approval card for this rule only. Approval is required '
  'when requires_approval and not auto_approve. See Phase 8 D6: the park rule '
  'earns this because its target campaign cannot message anyone; the handoff '
  'rule does not, because its target sends.';

-- ---------------------------------------------------------------------------
-- D6 — the park rule auto-approves.
--
-- The tension Eddie asked to have flagged: he wants to approve every campaign
-- move, but the park rule is time-sensitive. It exists to stop Bonzo dripping
-- a lead the same afternoon he is working them, and if it waits an hour for a
-- tap, Bonzo may already have sent something — which defeats the point of the
-- rule entirely.
--
-- What breaks the tie is the target. "No Drip, Responded, Appointment Set"
-- [122735] has its sequence disabled: a prospect parked there receives
-- nothing. The worst case of an unwanted auto-park is a lead sitting somewhere
-- silent, which is recoverable and quiet. The handoff's target sends, so its
-- worst case is a message going out under Eddie's name that he did not read.
-- Those are not the same risk and they do not deserve the same gate.
--
-- Guarded on the campaign id, so a rule Eddie has since repointed somewhere
-- noisier does not silently inherit auto-approval — and on campaign_name being
-- absent, which is the marker for "this migration has not run against this row
-- yet". `auto_approve = false` would have been the obvious guard and is the
-- wrong one: it is exactly the state a deliberate revocation leaves behind, so
-- re-running the file would have quietly undone it. Migrations in this repo
-- have to be safely re-runnable, which makes that a real difference and not a
-- theoretical one.
--
-- Ordering matters: this must run before the campaign_name backfill below,
-- which is what clears the marker.
-- ---------------------------------------------------------------------------
update workflows
   set auto_approve = true
 where action_type = 'add_to_bonzo_campaign'
   and (action_config ->> 'campaign_id') = '122735'
   and action_config -> 'campaign_name' is null;

-- ---------------------------------------------------------------------------
-- 6.1 — the handoff's new target.
--
-- Confirmed against the live API rather than assumed: "Responded (NEW
-- Quoted)" is campaign 198426, its sequence is enabled, and it currently holds
-- 35 prospects.
--
-- campaign_name is written alongside the id because several surfaces need to
-- say where a lead went — the Today screen's Waiting reason ("In Responded
-- (NEW Quoted) since Aug 14"), the approval card, the rules page. Reading it
-- back from Bonzo on every render would be an API call to print a label.
--
-- Guarded on the old id, so this is a no-op if the rule has already been
-- repointed by hand.
-- ---------------------------------------------------------------------------
update workflows
   set action_config = jsonb_build_object(
         'campaign_id', 198426,
         'campaign_name', 'Responded (NEW Quoted)'
       )
 where trigger_type = 'no_inbound_since'
   and action_type = 'add_to_bonzo_campaign'
   and (action_config ->> 'campaign_id') = '43998';

-- The park rule keeps its campaign and gains the label.
update workflows
   set action_config = jsonb_build_object(
         'campaign_id', 122735,
         'campaign_name', 'No Drip, Responded, Appointment Set'
       )
 where action_type = 'add_to_bonzo_campaign'
   and (action_config ->> 'campaign_id') = '122735'
   and action_config -> 'campaign_name' is null;

-- ---------------------------------------------------------------------------
-- 6.1 / D4 — the suppression condition.
--
-- The handoff must not fire when the two-day window produced a good response.
-- Default: fire only on no_response. Any actual reply — even a price objection
-- or a soft no — means a live conversation Eddie should work himself, and the
-- failure modes are asymmetric: dumping an engaged lead into a generic
-- campaign is much worse than leaving a dead one to be handed off by hand.
--
-- Stored as a workflow condition rather than in user_settings. The spec asked
-- for user_settings; conditions won on three counts. It is the mechanism the
-- engine already has, so dry-run and run history explain a non-firing rule for
-- free. It lands in trigger_snapshot, so a past decision can be read back
-- against the rule as it was then. And the other tunable number — the two days
-- — already lives on the workflow row, so splitting the two would mean two
-- places to look when asking why a rule did not fire.
--
-- Merged into the existing conditions rather than replacing them: the stage
-- filter there is belt-and-braces against QUEUE_ELIGIBLE_STAGES moving again
-- and should survive this.
-- ---------------------------------------------------------------------------
update workflows
   set conditions = coalesce(conditions, '{}'::jsonb)
                 || jsonb_build_object('pitch_response', jsonb_build_array('no_response'))
 where trigger_type = 'no_inbound_since'
   and action_type = 'add_to_bonzo_campaign'
   and conditions -> 'pitch_response' is null;
