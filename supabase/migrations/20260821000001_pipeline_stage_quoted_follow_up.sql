-- =============================================================================
-- Adds 'quoted_follow_up' to the pipeline_stage enum.
--
-- Phase 7 D1: the pitch is the moment everything changes, and this is the only
-- stage that gets automation. QUEUE_ELIGIBLE_STAGES moves from ['hot_lead'] to
-- ['quoted_follow_up'] in a later change, once this label exists to point at.
--
-- BEFORE 'app_in' places the label correctly in the enum's own sort order,
-- which is what `order by stage` and the SQL editor read. Board column order is
-- independent of this — it comes from PIPELINE_STAGES in types/db.ts.
--
-- One statement per file, same as 20260820000014 and ...15: the CLI wraps each
-- migration in a transaction, and a new enum label cannot be *used* in the
-- transaction that adds it.
-- =============================================================================

alter type pipeline_stage add value if not exists 'quoted_follow_up' before 'app_in';
