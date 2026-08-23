-- =============================================================================
-- Enrol on quote, rather than parking first.
--
-- "Responded (NEW Quoted)" [198426] does not touch a prospect until day 3 —
-- the two-day wait is built into the sequence itself. The previous design put
-- a lead in No Drip on entering Quoted – Follow Up and only moved them to the
-- live campaign after two quiet days, at which point the campaign started its
-- own two-day clock. Four days of silence from Bonzo where Eddie wanted two.
--
-- The fix is to enrol on arrival and let the campaign's own delay be the
-- window. The lead sits in a sending campaign that will not send for two days,
-- which is exactly the period Eddie works them by hand.
--
-- Two consequences follow, and both are handled here rather than left implied.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The park rule now enrols.
-- ---------------------------------------------------------------------------
update workflows
   set name = 'Enrol on quote',
       action_config = jsonb_build_object(
         'campaign_id', 198426,
         'campaign_name', 'Responded (NEW Quoted)'
       )
 where trigger_type = 'stage_changed'
   and action_type = 'add_to_bonzo_campaign'
   and (action_config ->> 'campaign_id') = '122735';

-- ---------------------------------------------------------------------------
-- 2. Auto-approve is revoked, because the reason for it is gone.
--
-- D6 granted this rule auto-approval on one specific argument: its target
-- campaign had its sequence disabled and could not message anyone, so the
-- worst case of an unwanted auto-enrolment was a lead sitting somewhere
-- silent. That is no longer true. 198426 sends, and a rule that enrols a lead
-- into a sending campaign without being asked is the thing requires_approval
-- exists for.
--
-- The time-sensitivity that motivated auto-approval also went away with it.
-- The whole point of parking immediately was that Bonzo might drip a lead the
-- same afternoon; a campaign that waits two days before its first touch gives
-- Eddie all the time he needs to tap approve.
--
-- Guarded on the new campaign id so this only ever applies to a rule that has
-- actually been repointed by the statement above.
-- ---------------------------------------------------------------------------
update workflows
   set auto_approve = false
 where trigger_type = 'stage_changed'
   and action_type = 'add_to_bonzo_campaign'
   and (action_config ->> 'campaign_id') = '198426'
   and auto_approve = true;

-- ---------------------------------------------------------------------------
-- 3. The handoff rule is now redundant, and is switched off.
--
-- It moved a lead to 198426 after two quiet days. A lead enrolled on arrival
-- is already there, so the rule is a no-op that would still write a run row,
-- still ask for approval, and still read on the rules page as something that
-- does work.
--
-- Left in place rather than deleted: the shape is right if Eddie ever wants a
-- second, later campaign, and its run history is worth keeping. Only its
-- enabled flag changes, so switching it back on is one click.
--
-- Note what this costs, because it is not nothing: the D4 suppression
-- condition lived on this rule, and it was what kept an engaged lead out of a
-- sending campaign. With enrolment happening on arrival, before anyone has
-- had a chance to reply, that protection no longer has anything to attach to.
-- A lead who replies on day one is already enrolled and the campaign will
-- reach them on day three. The remedy is stop-on-response on campaign 198426
-- in Bonzo, which this app deliberately cannot set.
-- ---------------------------------------------------------------------------
update workflows
   set enabled = false
 where trigger_type = 'no_inbound_since'
   and action_type = 'add_to_bonzo_campaign'
   and (action_config ->> 'campaign_id') = '198426'
   and enabled = true;
