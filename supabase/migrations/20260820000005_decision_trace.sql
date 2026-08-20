-- =============================================================================
-- 1.6 — decision_trace
--
-- Why a queue item exists, captured at the moment it was created. When a
-- suggestion is bad, this is what makes it possible to see which rule fired
-- and on what inputs, instead of guessing.
--
-- Also carries the model, prompt version, token counts and latency for the
-- drafting call, so spend is attributable per item rather than only as a
-- monthly total.
-- =============================================================================

alter table daily_queue add column if not exists decision_trace jsonb;

-- Computed by the engine ("Touch 2 of 3") and previously never displayed
-- anywhere. Promoted to a column so the card can render it directly rather
-- than digging into the trace.
alter table daily_queue add column if not exists touch_label text;

-- The lane that produced this item. A column rather than a trace key because
-- the board and queue filter on it.
alter table daily_queue add column if not exists lane text;

create index if not exists idx_daily_queue_lane
  on daily_queue (user_id, queue_date, lane)
  where lane is not null;
