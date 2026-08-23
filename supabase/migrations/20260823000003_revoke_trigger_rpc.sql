-- =============================================================================
-- Close the RPC surface on the stage-transition trigger function.
--
-- PostgREST exposes every function in the `public` schema as an endpoint, and
-- a SECURITY DEFINER one is worth being deliberate about: the linter flagged
-- log_stage_transition() as callable by both `anon` and `authenticated` via
-- /rest/v1/rpc/log_stage_transition.
--
-- It is not actually exploitable — plpgsql refuses to run a trigger function
-- outside a trigger context, so a direct call errors before reaching the
-- insert. But "it happens to fail" is a weaker guarantee than "it cannot be
-- called", and the definer rights the function genuinely needs (see
-- 20260823000001) are exactly what makes the difference worth closing.
--
-- Nothing loses access it was using: the function is only ever reached through
-- the trigger, which runs as the table owner regardless of who holds EXECUTE.
-- =============================================================================

revoke all on function public.log_stage_transition() from public;
revoke all on function public.log_stage_transition() from anon;
revoke all on function public.log_stage_transition() from authenticated;
