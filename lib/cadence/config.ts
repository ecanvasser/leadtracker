/**
 * Cadence constants, formerly hardcoded in the engine.
 *
 * Stored on user_settings.cadence_config and editable from Settings, so
 * tuning the machine does not require a deploy.
 */

export interface CadenceConfig {
  /** Sunday on/off, replacing the hardcoded isSunday() bail-out. */
  work_sunday: boolean;
  work_saturday: boolean;
  saturday_max_messages: number;
  saturday_calls: boolean;

  /**
   * Consecutive unanswered outbound messages before a lead is called dead and
   * surfaced as "recommend moving to Adverse".
   */
  unresponsive_max_consecutive: number;

  /**
   * Minimum days between touches on the blocked lane. A blocked lead does not
   * need a rhythm; it needs a reason. This is the floor for the case where a
   * genuinely meaningful interval has elapsed.
   */
  blocked_min_days_between_touches: number;

  /** Above this age a lead is no longer treated as actively in market. */
  in_market_max_age_days: number;
}

export const DEFAULT_CADENCE_CONFIG: CadenceConfig = {
  work_sunday: false,
  work_saturday: true,
  saturday_max_messages: 1,
  saturday_calls: false,
  unresponsive_max_consecutive: 5,
  blocked_min_days_between_touches: 21,
  in_market_max_age_days: 14,
};

/**
 * Merges a stored config over the defaults.
 *
 * A missing or malformed key falls back rather than throwing: a bad value in
 * one field should not take the whole queue down, and the queue silently
 * producing nothing is worse than it running on a default.
 */
export function resolveCadenceConfig(
  stored: unknown | null | undefined
): CadenceConfig {
  if (!stored || typeof stored !== "object") return { ...DEFAULT_CADENCE_CONFIG };
  const raw = stored as Record<string, unknown>;
  const out = { ...DEFAULT_CADENCE_CONFIG };

  for (const key of Object.keys(DEFAULT_CADENCE_CONFIG) as (keyof CadenceConfig)[]) {
    const value = raw[key];
    const expected = typeof DEFAULT_CADENCE_CONFIG[key];
    if (typeof value === expected) {
      // @ts-expect-error key/value types line up by construction above
      out[key] = value;
    }
  }

  // Guard against values that would make the engine nonsensical.
  out.unresponsive_max_consecutive = Math.max(1, out.unresponsive_max_consecutive);
  out.blocked_min_days_between_touches = Math.max(
    1,
    out.blocked_min_days_between_touches
  );
  out.in_market_max_age_days = Math.max(0, out.in_market_max_age_days);
  out.saturday_max_messages = Math.max(0, out.saturday_max_messages);

  return out;
}
