/**
 * Post-pitch badges, shared by the board card and the Today row.
 *
 * One map rather than two: the same fact must not be orange in one place and
 * grey in another. Colour carries the urgency, the label carries the fact.
 */
export const PITCH_STYLE: Record<string, { label: string; className: string }> = {
  converted_signal: { label: "Reads like a yes", className: "bg-green-500/15 text-green-600 dark:text-green-400" },
  positive_intent: { label: "Interested", className: "bg-orange-500/15 text-orange-600 dark:text-orange-400" },
  needs_info: { label: "Needs info", className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  price_objection: { label: "Price", className: "bg-red-500/15 text-red-600 dark:text-red-400" },
  timing_objection: { label: "Timing", className: "bg-slate-500/15 text-slate-600 dark:text-slate-400" },
  competitor: { label: "Competitor", className: "bg-red-500/15 text-red-600 dark:text-red-400" },
  soft_no: { label: "Soft no", className: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400" },
  no_response: { label: "No reply", className: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400" },
};
