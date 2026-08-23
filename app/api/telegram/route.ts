import { webhookCallback } from "grammy";
import { createBot } from "@/lib/telegram/bot";
import { createServiceClient } from "@/lib/supabase/service";
import { checkUpdateProcessed } from "@/lib/db/telegram";
import {
  handleStart,
  handleHelp,
  handleTodo,
  handleAdd,
  handleList,
  handleMove,
  handleTask,
  handleDone,
  handleDelete,
  handleCallbackQuery,
  handleTextMessage,
} from "@/lib/telegram/commands";
import { handlePause, handleResume } from "@/lib/telegram/workflow-handlers";
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";

function verifySecret(request: NextRequest): boolean {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return false;

  const header = request.headers.get("x-telegram-bot-api-secret-token");
  if (!header) return false;

  try {
    const a = Buffer.from(secret, "utf8");
    const b = Buffer.from(header, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

let handler: ((req: Request) => Promise<Response>) | null = null;

function getHandler(): (req: Request) => Promise<Response> {
  if (handler) return handler;

  const bot = createBot();

  bot.command("start", handleStart);
  bot.command("help", handleHelp);
  bot.command("todo", handleTodo);
  bot.command("add", handleAdd);
  bot.command("list", handleList);
  bot.command("move", handleMove);
  bot.command("task", handleTask);
  bot.command("done", handleDone);
  bot.command("delete", handleDelete);
  // 4.4 kill switch, reachable from the phone.
  bot.command("pause", handlePause);
  bot.command("resume", handleResume);
  bot.on("callback_query:data", handleCallbackQuery);
  bot.on("message:text", handleTextMessage);

  handler = webhookCallback(bot, "std/http") as unknown as (req: Request) => Promise<Response>;
  return handler;
}

export async function POST(request: NextRequest) {
  if (!verifySecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();

    if (body.update_id) {
      const supabase = createServiceClient();
      const alreadyProcessed = await checkUpdateProcessed(supabase, body.update_id);
      if (alreadyProcessed) {
        return NextResponse.json({ ok: true });
      }
    }

    const fakeRequest = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(body),
    });

    return await getHandler()(fakeRequest);
  } catch (e) {
    console.error("Telegram webhook error:", e);
    return NextResponse.json({ ok: true });
  }
}
