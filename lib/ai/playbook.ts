/**
 * Eddie's own context, in his words.
 *
 * Everything the drafter knows about mortgages it inferred from one lead's
 * transcript. That is enough to avoid saying something false and nowhere near
 * enough to sound like someone who does this for a living — which programs he
 * actually places, how he answers the objection he has answered four hundred
 * times, what he says when a competitor has quoted lower.
 *
 * That knowledge lives in his Claude Cowork project. It is *documents*, not a
 * running agent, so it belongs in the prompt rather than behind a session:
 * pasted here, it is version-controlled, diffable against a change in draft
 * quality, and costs almost nothing to send because the block is cached.
 *
 * ## Keeping it current
 *
 * Re-export from Cowork and replace the string below. Because this is a
 * committed file, `git log -p lib/ai/playbook.ts` answers "what did I change
 * just before the drafts got worse", which a live session could never tell
 * you.
 *
 * ## What belongs here
 *
 * Things that are true across every lead: programs and their rough shape, how
 * he talks about rate versus payment, the objections and his actual answers,
 * what he will and will not promise. Written the way he would say it.
 *
 * ## What does not
 *
 * Anything about a specific lead — that already reaches the prompt from Bonzo
 * and the classifier, and it is fresher there. Anything with a number in it
 * that changes: a rate sheet pasted here goes stale silently and the validator
 * cannot catch it, because a figure in the playbook counts as grounded. Keep
 * live numbers out.
 */

/**
 * Paste the exported context between the backticks.
 *
 * If any of it contains a backtick or `${`, escape it — this is a template
 * literal, and an unescaped one will break the build rather than fail quietly,
 * which is the failure to prefer.
 */
export const BROKER_PLAYBOOK = ``;

/**
 * The playbook as a prompt block, or null when it is empty.
 *
 * Null rather than an empty string so the caller drops the block entirely: a
 * heading with nothing under it reads to a model as "he has no approach",
 * which is worse than not raising the subject.
 */
export function playbookBlock(): string | null {
  const text = BROKER_PLAYBOOK.trim();
  if (!text) return null;

  return (
    `HOW HE WORKS — his own notes, and more reliable than anything you infer ` +
    `from one conversation:\n\n${text}\n\n` +
    `Use this for substance: which programs are plausible, how he answers an ` +
    `objection, what he does and does not promise. It is background, not a ` +
    `script — never quote it at the lead, and never let it override a figure ` +
    `from the loan file or something the lead actually said.`
  );
}

/** Whether any context has been pasted in. Surfaced in Settings. */
export function hasPlaybook(): boolean {
  return BROKER_PLAYBOOK.trim().length > 0;
}
