-- =============================================================================
-- Phase 8 — what the Today screen reads.
--
-- Two additions, both driven by D1: the refresh sweep widens from Quoted –
-- Follow Up to every non-terminal stage, so that "did this person ask me
-- something I haven't answered" — the most valuable signal in the product —
-- is knowable for a Hot Lead and a Needs Quote lead, not only for the one
-- stage that gets classified.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- insights_cache.last_outbound_at
--
-- The inbound watermark already exists (2.4). The outbound side was only ever
-- available inside lead_state, which is written by the classifier — and the
-- classifier stays gated on Quoted – Follow Up even now the sweep is wider.
-- So a Needs Quote lead would have an inbound watermark and no outbound one,
-- and "whose turn is it" is a comparison between the two. Promoting it to a
-- column is what lets the widened sweep stay free of model calls.
-- ---------------------------------------------------------------------------
alter table insights_cache
  add column if not exists last_outbound_at timestamptz;

-- Seed from what is already cached, mirroring the inbound backfill in 2.4 —
-- including its vocabulary problem. Bonzo writes "outgoing", not "outbound",
-- and cached payloads may predate the normalisation in lib/bonzo/client.ts,
-- so both are accepted. Matching only one would leave every watermark null
-- and read as "never messaged them", which would put the entire pipeline in
-- Eddie's Your move column on the first load of the new screen.
update insights_cache
set last_outbound_at = (
  select max((m ->> 'created_at')::timestamptz)
  from jsonb_array_elements(bonzo_communication) as m
  where lower(m ->> 'direction') in ('outgoing', 'outbound', 'out', 'sent')
)
where last_outbound_at is null
  and bonzo_communication is not null
  and jsonb_typeof(bonzo_communication) = 'array';

comment on column insights_cache.last_outbound_at is
  'Newest outbound message in the Bonzo thread. Written by refresh_cache for '
  'every non-terminal stage, without a model call. Paired with '
  'last_inbound_at, this is what lib/turn/ compares to decide whose move it '
  'is.';

-- ---------------------------------------------------------------------------
-- Today thresholds
--
-- Section 2.4 wants the overdue threshold tunable without a deploy, which is
-- the whole reason it is a column rather than a constant.
-- ---------------------------------------------------------------------------
alter table user_settings
  add column if not exists today_overdue_days integer not null default 2;

alter table user_settings
  add column if not exists today_recent_touch_hours integer not null default 4;

do $$ begin
  alter table user_settings add constraint user_settings_today_overdue_days_sane
    check (today_overdue_days between 1 and 30);
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table user_settings add constraint user_settings_today_recent_touch_sane
    check (today_recent_touch_hours between 1 and 72);
exception when duplicate_object then null;
end $$;

comment on column user_settings.today_overdue_days is
  'Days of silence before a "their move" lead surfaces in the second Today '
  'section. Below this it sits in Waiting — visible, not shouting.';

-- ---------------------------------------------------------------------------
-- The widened sweep needs a wider index
--
-- The existing idx_contacts_user_stage_pos leads with stage, which suited a
-- sweep selecting one stage. The sweep now selects everything except two
-- terminal stages, so the useful index is the enrolment filter instead.
-- ---------------------------------------------------------------------------
create index if not exists idx_contacts_user_prospect
  on contacts (user_id, stage)
  where bonzo_prospect_id is not null;
