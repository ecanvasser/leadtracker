-- =============================================================================
-- 2.2 / 2.3 — Telegram approval flow
--
-- Adds what the card lifecycle needs: snoozing as a first-class outcome
-- distinct from skipping, and a record of which card is currently outstanding
-- so pushes can be throttled to one at a time.
-- =============================================================================

-- Snooze is "not right now"; skip is "not this". Collapsing them, as the UI
-- did, loses the distinction that matters for cadence.
alter table daily_queue add column if not exists snoozed_until timestamptz;

-- The Telegram message carrying this item's approval card, so it can be
-- edited in place when the item is actioned rather than leaving a stale card
-- with live buttons in the chat.
alter table daily_queue add column if not exists telegram_message_id bigint;
alter table daily_queue add column if not exists pushed_at timestamptz;

-- Finding the next item to push: pending, not snoozed into the future, in
-- priority order.
create index if not exists idx_daily_queue_pushable
  on daily_queue (user_id, queue_date, priority_rank)
  where status = 'pending';

-- Finding the outstanding card. Partial so it stays tiny — at most one row
-- per user matches at any time.
create index if not exists idx_daily_queue_outstanding
  on daily_queue (user_id, pushed_at)
  where status = 'pending' and telegram_message_id is not null;

-- ---------------------------------------------------------------------------
-- Callback idempotency
--
-- processed_updates already dedupes by Telegram update_id, which covers a
-- webhook redelivery. It does NOT cover the broker tapping Send twice: those
-- are two distinct updates carrying the same intent, and the second would
-- deliver a second message to the prospect.
--
-- This records the intent itself. Domain handlers stay idempotent regardless
-- (see lib/outreach/send.ts) — this is the cheap first line, not the only one.
-- ---------------------------------------------------------------------------
create table if not exists telegram_actions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  queue_item_id     uuid not null references daily_queue(id) on delete cascade,
  action            text not null,
  created_at        timestamptz not null default now()
);

-- One terminal action per queue item. A second Send on the same card violates
-- this and is rejected before anything reaches Bonzo.
create unique index if not exists idx_telegram_actions_once
  on telegram_actions (queue_item_id, action);

alter table telegram_actions enable row level security;

drop policy if exists "own_telegram_actions" on telegram_actions;
create policy "own_telegram_actions" on telegram_actions
  for select using (auth.uid() = user_id);
