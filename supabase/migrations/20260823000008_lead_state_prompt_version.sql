-- =============================================================================
-- insights_cache.lead_state_prompt_version
--
-- A cached classifier read is only as good as the prompt that produced it, and
-- nothing recorded which prompt that was. The consequence surfaced the first
-- time the prompt was improved: the leads the change was written for are the
-- ones who have gone quiet, and a quiet lead's read never gets recomputed, so
-- the improvement could not reach a single one of them. Every draft kept
-- inheriting an angle written by a prompt that had already been replaced.
--
-- Stamping the read with a fingerprint of the prompt makes a prompt change
-- invalidate its own output. Null on every existing row, which reclassifies
-- each of them once — correct, since those were written by a prompt we can no
-- longer identify.
--
-- Cheap by construction: only leads in Quoted – Follow Up are ever classified,
-- and the reclassification happens once per prompt change rather than on a
-- schedule.
-- =============================================================================

alter table insights_cache
  add column if not exists lead_state_prompt_version text;

comment on column insights_cache.lead_state_prompt_version is
  'Fingerprint of the classifier system prompt that produced lead_state. When '
  'it stops matching CLASSIFY_PROMPT_VERSION the read is recomputed. Null '
  'means the read predates this column and should be recomputed once.';
