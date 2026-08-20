-- =============================================================================
-- 3.3 — Schedule the call reminder dispatcher
--
-- Every minute, because a T-15 reminder that arrives at T-9 is not a reminder.
-- The function itself is cheap: one indexed query that returns nothing on the
-- overwhelming majority of runs.
--
-- This is the second and final cron job. Supabase guidance is to keep
-- concurrent schedules in the single digits and each job under ten minutes;
-- one five-minute worker tick and one one-minute dispatcher, both finishing in
-- well under a second, sits comfortably inside that. Do not add a third
-- without weighing it.
--
-- Auth is a bearer shared secret, matching the queue worker. Deliberately not
-- a JWT: signing one in Postgres would need pgjwt (deprecated in PG 17) or
-- pgsodium (Supabase advises against new usage).
--
-- Requires, as one-time manual setup in the SQL editor:
--   select vault.create_secret('<long random string>', 'reminder_secret');
--   select vault.create_secret('https://<project>.supabase.co', 'functions_url');
-- and the matching function secret:
--   supabase secrets set REMINDER_SECRET=<the same string>
-- =============================================================================

do $$
declare
  has_cron    boolean;
  has_net     boolean;
  has_secret  boolean;
  has_url     boolean;
begin
  select exists (select 1 from pg_extension where extname = 'pg_cron') into has_cron;
  select exists (select 1 from pg_extension where extname = 'pg_net')  into has_net;

  if not has_cron or not has_net then
    raise notice 'pg_cron/pg_net not enabled — skipping call reminder schedule.';
    return;
  end if;

  select exists (select 1 from vault.decrypted_secrets where name = 'reminder_secret')
    into has_secret;
  select exists (select 1 from vault.decrypted_secrets where name = 'functions_url')
    into has_url;

  if not has_secret or not has_url then
    -- Scheduling without these would produce a job that fails every minute and
    -- fills cron.job_run_details with noise. Better to skip and say why.
    raise notice 'Vault is missing reminder_secret and/or functions_url — skipping call reminder schedule. Create both, then re-run this migration.';
    return;
  end if;

  perform cron.unschedule('leadtracker-call-reminders')
  where exists (select 1 from cron.job where jobname = 'leadtracker-call-reminders');

  perform cron.schedule(
    'leadtracker-call-reminders',
    '* * * * *',
    $cron$
    select net.http_post(
      url := rtrim(
        (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url'),
        '/'
      ) || '/functions/v1/call-reminders',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret from vault.decrypted_secrets where name = 'reminder_secret'
        )
      ),
      body := jsonb_build_object('source', 'cron'),
      timeout_milliseconds := 20000
    );
    $cron$
  );
end $$;
