-- The unique constraint on (contact_id, action_type, queue_date) is too
-- restrictive — Day 1 leads need multiple SMS or call actions per day.
-- The generate endpoint already deletes and re-inserts, so dedup is handled
-- at the application level.
drop index if exists daily_queue_contact_id_action_type_queue_date_idx;
