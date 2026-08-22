-- =============================================================================
-- Adds 'funded' to the pipeline_stage enum.
--
-- Phase 7 D1: the pipeline had no terminal success state, so a closed deal sat
-- in Processing forever. 'funded' is deliberately NOT a board column — like
-- 'adverse' it is excluded from PIPELINE_STAGES and listed on its own page.
-- A funded deal is finished; it should leave the board rather than accumulate
-- in a column that only ever grows.
--
-- AFTER 'processing' so the enum's sort order matches the real sequence, and
-- so 'funded' sorts before 'adverse' rather than landing at the end next to it.
--
-- One statement per file — see 20260821000001.
-- =============================================================================

alter type pipeline_stage add value if not exists 'funded' after 'processing';
