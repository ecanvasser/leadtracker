-- =============================================================================
-- release_jobs — return claimed-but-unrun jobs to pending
--
-- claim_jobs marks a whole batch 'running' and increments attempts up front.
-- When the worker stops early on its time budget, the jobs it never reached
-- are still marked running with an attempt spent.
--
-- Left alone they sit until the ten-minute stuck-job reaper, which counts that
-- as a failed attempt — so a job that never started burns a retry, and any
-- handler that calls the model pays for the work twice on the eventual rerun.
--
-- Both halves must happen together, which is why this is one statement rather
-- than an update plus a loop in the application.
-- =============================================================================

create or replace function release_jobs(job_ids uuid[])
returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare
  released int;
begin
  with freed as (
    update jobs
    set status = 'pending',
        locked_at = null,
        -- Undo the speculative increment from claim_jobs. Floored at zero so a
        -- double release cannot drive the count negative.
        attempts = greatest(0, attempts - 1)
    where id = any(job_ids)
      and status = 'running'
    returning 1
  )
  select count(*) into released from freed;
  return released;
end;
$fn$;

revoke all on function release_jobs(uuid[]) from public, anon, authenticated;
