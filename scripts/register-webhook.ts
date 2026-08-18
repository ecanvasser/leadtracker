const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET!;
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL!;

async function main() {
  const webhookUrl = `${SITE_URL}/api/telegram`;

  console.log(`Setting webhook to: ${webhookUrl}`);

  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"],
      }),
    }
  );

  const data = await res.json();
  console.log("setWebhook response:", JSON.stringify(data, null, 2));

  const infoRes = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`
  );
  const info = await infoRes.json();
  console.log("getWebhookInfo:", JSON.stringify(info, null, 2));
}

main().catch(console.error);
