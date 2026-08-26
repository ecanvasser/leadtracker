import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { loadToday } from "@/lib/turn/load";
import { callsForDay, overdueCalls, wantsCallLeads } from "@/lib/calls/book";
import { createServiceClient } from "@/lib/supabase/service";
import { loadSpeedToQuote } from "@/lib/turn/speed";
import { TodayScreen } from "./today-screen";

// Every other authenticated page in the app declares this. The three counts
// are read per-request from the database and per-user; there is nothing here
// that could be prerendered without being wrong.
export const instant = false;

/**
 * Today — one prioritised worklist, organised around a single question:
 * whose turn is it?
 *
 * Server-rendered from lib/turn/load.ts, which the Telegram /today command
 * also calls. Nothing about the three counts is computed twice.
 */
export default async function TodayPage() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) redirect("/login");

  const userId = authData.claims.sub as string;
  const [board, speed] = await Promise.all([
    loadToday(supabase, userId),
    loadSpeedToQuote(supabase, userId),
  ]);

  // Service client: scheduled_calls joins contacts, and the day list is read
  // on every page load — going through RLS twice for a join we already know is
  // scoped by user_id buys nothing.
  const service = createServiceClient();
  const [calls, overdue, wantsCall] = await Promise.all([
    callsForDay(service, userId, board.timeZone),
    overdueCalls(service, userId),
    wantsCallLeads(service, userId),
  ]);

  return (
    <TodayScreen
      yourMove={board.your_move}
      theirMove={board.their_move}
      waiting={board.waiting}
      counts={board.counts}
      timeZone={board.timeZone}
      calls={calls}
      overdueCalls={overdue}
      wantsCall={wantsCall}
      overdueDays={board.settings.overdueDays}
      speed={speed}
    />
  );
}
