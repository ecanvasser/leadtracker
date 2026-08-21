-- =============================================================================
-- Adds 'needs_quote' to the pipeline_stage enum.
--
-- BEFORE 'app_in' places the label correctly in the enum's own sort order,
-- which is what `order by stage` and the SQL editor read. Board column order is
-- independent of this — it comes from PIPELINE_STAGES in types/db.ts.
--
-- One statement, for the same reason as 20260820000014: a new enum label cannot
-- be used in the transaction that adds it.
-- =============================================================================

alter type pipeline_stage add value if not exists 'needs_quote' before 'app_in';
