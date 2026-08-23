/**
 * Deep link to a prospect in Bonzo.
 *
 * Lives here rather than beside the Bonzo API client because both the
 * Telegram card and the Today row need it, and the client module reads the
 * API token at import time. Kept out of lib/telegram/ for the same reason in
 * reverse: that module imports grammY, which has no business in a browser
 * bundle.
 *
 * The app only ever links out. It never dials — see the hard non-goals.
 */
export function bonzoProspectUrl(prospectId: number): string {
  return `https://platform.getbonzo.com/prospect/${prospectId}`;
}
