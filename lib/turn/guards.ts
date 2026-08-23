/** Is `value` a parseable instant strictly after `now`? */
export function isFuture(value: string | null | undefined, now: Date): boolean {
  if (!value) return false;
  const t = new Date(value).getTime();
  return Number.isFinite(t) && t > now.getTime();
}
