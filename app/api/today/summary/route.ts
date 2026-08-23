import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadToday } from "@/lib/turn/load";

/**
 * The three Today counts, for the nav badge.
 *
 * Goes through loadToday rather than counting rows itself. A badge that
 * disagrees with the screen it links to is worse than no badge — and the
 * moment this route grows its own idea of what "your move" means, the two
 * will drift. Section 5.1 makes the same point about the Telegram bot.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const board = await loadToday(supabase, authData.claims.sub as string);

  return NextResponse.json(board.counts);
}
