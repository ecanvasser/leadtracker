-- =============================================================================
-- Marks the voice-profile columns dead without dropping them.
--
-- Phase 7 retired the drafting subsystem, so nothing reads or writes
-- user_settings.voice_profile or voice_profile_generated_at any more. The
-- columns stay: production's migration history was originally empty and this
-- schema is forward-only, so dropping a column that holds data is ruled out.
--
-- A COMMENT is the one place a future reader — or a future agent — will see
-- this before wiring the column back up. Idempotent by nature: COMMENT ON
-- replaces whatever was there.
-- =============================================================================

comment on column user_settings.voice_profile is
  'DEAD as of Phase 7. The drafting subsystem that produced and consumed this '
  'was removed; nothing reads or writes it. Retained because the schema is '
  'forward-only and the column holds data. Do not wire new code to it.';

comment on column user_settings.voice_profile_generated_at is
  'DEAD as of Phase 7. See the comment on user_settings.voice_profile.';
