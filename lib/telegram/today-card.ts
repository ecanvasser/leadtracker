/**
 * `/today` on the phone — Phase 8 section 5.1.
 *
 * The bot answers the same three questions the web page does, from the same
 * function. Not "similar logic in both places": `loadToday` is called here and
 * nowhere is a count recomputed. The spec is explicit that if the two can ever
 * disagree, that is a bug, and the only way to guarantee they cannot is to
 * have one implementation.
 *
 * What is deliberately different is how much is shown. The page lists
 * everything; a phone gets the counts and the top few of each actionable
 * section, because the point of reaching for it is to find out whether
 * anything needs doing before opening a laptop.
 */

import { InlineKeyboard } from "grammy";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadToday, type LoadTodayResult } from "@/lib/turn/load";
import { describeWait } from "@/lib/turn/format";
import { bonzoProspectUrl } from "@/lib/turn/links";
import { PITCH_STYLE } from "@/lib/turn/badges";
import type { TurnResult } from "@/lib/turn/types";
import { LOAN_TYPE_LABELS } from "@/types/db";

/** Callback codes. Telegram caps callback_data at 64 bytes. */
export const TODAY_CB = {
  done: "yd",
  snooze: "ys",
  snoozeApply: "ya",
  refresh: "yr",
} as const;

/**
 * How many rows of each actionable section the card shows.
 *
 * Three, because a Telegram message is a glance. The counts above are the
 * answer; the rows are a sample of what is behind them, oldest first, so the
 * three shown are always the three that have waited longest.
 */
const ROWS_PER_SECTION = 3;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function rowLine(row: TurnResult, now: Date, timeZone: string): string {
  const parts = [`<b>${escapeHtml(row.contact.name)}</b>`];
  parts.push(LOAN_TYPE_LABELS[row.contact.loan_type]);

  // Section 2.2 holds here too: an unknown or sub-day duration is omitted or
  // said in words, never rendered as "0 days".
  const wait = describeWait(row.waiting_since, now, timeZone);
  if (wait) parts.push(wait);

  const pitch = row.leadState?.pitch_response
    ? PITCH_STYLE[row.leadState.pitch_response]?.label
    : null;
  if (pitch) parts.push(pitch);

  let line = `· ${parts.join(" · ")}`;

  const angle = row.leadState?.suggested_angle?.trim();
  if (angle) line += `\n   <i>${escapeHtml(angle)}</i>`;

  return line;
}

export interface TodayCard {
  text: string;
  keyboard: InlineKeyboard;
  board: LoadTodayResult;
}

export async function buildTodayCard(
  supabase: SupabaseClient,
  userId: string,
  now: Date = new Date()
): Promise<TodayCard> {
  const board = await loadToday(supabase, userId, now);
  const { counts, timeZone } = board;

  const lines: string[] = [
    `<b>Today</b> — ${counts.your_move} yours · ${counts.their_move} overdue · ${counts.waiting} waiting`,
  ];

  if (counts.your_move === 0 && counts.their_move === 0) {
    // Section 2.5: an empty Today is a win, and says so.
    lines.push(
      counts.waiting > 0
        ? `\nYou're caught up. ${counts.waiting} ${counts.waiting === 1 ? "lead is" : "leads are"} accounted for and waiting.`
        : "\nNothing active."
    );
  }

  if (counts.your_move > 0) {
    lines.push(`\n<b>Your move (${counts.your_move})</b>`);
    for (const row of board.your_move.slice(0, ROWS_PER_SECTION)) {
      lines.push(rowLine(row, now, timeZone));
    }
    if (counts.your_move > ROWS_PER_SECTION) {
      lines.push(`<i>+ ${counts.your_move - ROWS_PER_SECTION} more</i>`);
    }
  }

  if (counts.their_move > 0) {
    lines.push(`\n<b>Overdue (${counts.their_move})</b>`);
    for (const row of board.their_move.slice(0, ROWS_PER_SECTION)) {
      lines.push(rowLine(row, now, timeZone));
    }
    if (counts.their_move > ROWS_PER_SECTION) {
      lines.push(`<i>+ ${counts.their_move - ROWS_PER_SECTION} more</i>`);
    }
  }

  /*
   * Buttons for the shown rows only, one row of controls per lead.
   *
   * Naming each button after its lead rather than using a generic
   * "Done"/"Snooze" pair: with several leads on one card, an unlabelled
   * button is a coin flip, and the whole point of approving from a phone is
   * that it is unambiguous.
   */
  const keyboard = new InlineKeyboard();
  const shown = [
    ...board.your_move.slice(0, ROWS_PER_SECTION),
    ...board.their_move.slice(0, ROWS_PER_SECTION),
  ];

  for (const row of shown) {
    const first = row.contact.name.split(" ")[0];
    keyboard
      .text(`✓ ${first}`, `${TODAY_CB.done}:${row.contact.id}`)
      .text(`⏱ ${first}`, `${TODAY_CB.snooze}:${row.contact.id}`);
    if (row.contact.bonzo_prospect_id) {
      keyboard.url("Bonzo", bonzoProspectUrl(row.contact.bonzo_prospect_id));
    }
    keyboard.row();
  }

  keyboard.text("Refresh", TODAY_CB.refresh);

  return { text: lines.join("\n"), keyboard, board };
}

/** Snooze durations, matching the web row's options. */
export const SNOOZE_CHOICES = [
  { label: "Tomorrow", days: 1 },
  { label: "3 days", days: 3 },
  { label: "Next week", days: 7 },
] as const;

export function snoozeKeyboard(contactId: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const choice of SNOOZE_CHOICES) {
    kb.text(choice.label, `${TODAY_CB.snoozeApply}:${contactId}:${choice.days}`);
  }
  return kb.row().text("← Back", TODAY_CB.refresh);
}
