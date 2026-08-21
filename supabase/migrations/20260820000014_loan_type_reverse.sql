-- =============================================================================
-- Adds 'reverse' to the loan_type enum.
--
-- This file contains ONE statement on purpose. The CLI wraps each migration in
-- a transaction, and Postgres will not let a new enum label be *used* in the
-- transaction that added it. Anything that references 'reverse' — a default, a
-- check constraint, a data update — belongs in a later file.
-- =============================================================================

alter type loan_type add value if not exists 'reverse';
