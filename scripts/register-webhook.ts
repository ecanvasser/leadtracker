/**
 * Registers the Telegram webhook.
 *
 * Listed in the deployment checklist as the way to re-point the bot after a
 * deployment URL change.
 *
 * The guard below is the important part. NEXT_PUBLIC_SITE_URL in a local
 * .env.local is normally http://localhost:3000, and running this script with
 * that value silently points the live bot at a machine Telegram cannot reach —
 * the bot then goes quiet with no error anywhere obvious. Telegram also
 * rejects non-HTTPS webhook URLs outright, so the failure mode is either a
 * dead bot or a confusing API error.
 *
 * Usage:
 *   SITE_URL=https://your-app.vercel.app npx tsx scripts/register-webhook.ts
 *   npx tsx scripts/register-webhook.ts --info     (inspect, change nothing)
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

// SITE_URL wins over NEXT_PUBLIC_SITE_URL so the production URL can be given
// explicitly without editing .env.local.
const SITE_URL = process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL;

const infoOnly = process.argv.includes("--info");

function fail(message: string): never {
  console.error(`\n✕ ${message}\n`);
  process.exit(1);
}

async function showInfo(): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
  const data = await res.json();

  if (!data.ok) fail(`getWebhookInfo failed: ${data.description}`);

  const r = data.result;
  console.log("Current webhook:");
  console.log(`  url:                  ${r.url || "(none registered)"}`);
  console.log(`  pending_update_count: ${r.pending_update_count}`);
  console.log(`  allowed_updates:      ${JSON.stringify(r.allowed_updates ?? "all")}`);
  if (r.last_error_message) {
    console.log(`  last_error_date:      ${new Date(r.last_error_date * 1000).toISOString()}`);
    console.log(`  last_error_message:   ${r.last_error_message}`);
  } else {
    console.log(`  last_error_message:   (none)`);
  }
}

async function main() {
  if (!BOT_TOKEN) fail("TELEGRAM_BOT_TOKEN is not set.");

  if (infoOnly) {
    await showInfo();
    return;
  }

  if (!WEBHOOK_SECRET) fail("TELEGRAM_WEBHOOK_SECRET is not set.");
  if (!SITE_URL) fail("Set SITE_URL (or NEXT_PUBLIC_SITE_URL) to the public app URL.");

  let parsed: URL;
  try {
    parsed = new URL(SITE_URL);
  } catch {
    fail(`SITE_URL is not a valid URL: ${SITE_URL}`);
  }

  // The guard. A local URL here takes the live bot offline silently.
  const isLocal =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname.endsWith(".local");

  if (isLocal) {
    fail(
      `Refusing to register a local webhook URL (${SITE_URL}).\n` +
        `  Telegram cannot reach it, and registering it takes the live bot offline\n` +
        `  with no visible error. Pass the public URL instead:\n\n` +
        `    SITE_URL=https://your-app.vercel.app npx tsx scripts/register-webhook.ts\n\n` +
        `  To inspect the current registration without changing it:\n\n` +
        `    npx tsx scripts/register-webhook.ts --info`
    );
  }

  if (parsed.protocol !== "https:") {
    fail(`Telegram requires an HTTPS webhook URL. Got: ${SITE_URL}`);
  }

  const webhookUrl = `${SITE_URL.replace(/\/+$/, "")}/api/telegram`;
  console.log(`Setting webhook to: ${webhookUrl}`);

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
    }),
  });

  const data = await res.json();
  if (!data.ok) fail(`setWebhook failed: ${data.description}`);
  console.log(`✓ ${data.description ?? "Webhook set"}\n`);

  await showInfo();
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));

export {};
