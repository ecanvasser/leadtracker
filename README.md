# LeadTracker

A sales copilot for a mortgage broker. It watches hot leads and says, lead by
lead, what to send and when — and waits to be told yes.

**This is not a CRM.** Bonzo is the system of record. LeadTracker reads from it,
drafts against it, and sends through it. Nothing here duplicates contact
management.

## What it does

Telegram is the primary surface. It pushes an approval card — who, why now,
what the prospect last said, and the exact message that will go out — and the
broker sends, edits, redrafts, snoozes or skips. Approved messages go out
through the Bonzo API. The web app is for review and configuration.

Two lead archetypes drive everything:

- **Newer leads (roughly 0–14 days)** are in the market right now. Speed wins.
  The goal is a conversation and a scheduled call.
- **Older leads (15+ days)** are almost always held back by something specific —
  a past denial, credit, equity, income, DTI, timing, or another lender. The job
  is not to check in. It is to identify the blocker and either deliver a real
  reason it may have changed, or stay quiet.

The engine is allowed to recommend doing nothing, and frequently does.

### Deliberate non-goals

- **No automatic lead ingestion.** Leads are added by hand. Nothing creates a
  contact without a button press.
- **No calling from the app.** No dialer, no `tel:` links, no Twilio. It reminds
  and deep links to Bonzo; the call happens there.
- **Hot leads only.** The `stage = 'hot_lead'` filter on queue generation and
  insights enrollment is intentional.

## Architecture

```
Next.js (Vercel)                    Postgres (Supabase)
├── web app: board, queue, settings ├── schema + RLS
├── /api/telegram   webhook         ├── jobs           durable queue
├── /api/worker/drain               ├── pg_cron        two schedules
└── lib/                            └── Vault          secrets for cron
    ├── cadence/    lane selection
    ├── ai/         prompts, validation, drafting      Supabase Edge Function
    ├── insights/   lead state classification          └── call-reminders
    ├── calls/      detection + timezone resolution
    ├── bonzo/      API client
    └── telegram/   cards, sessions, approvals
```

**Scheduling lives in Postgres; application logic stays in the Next.js app.**
The cadence engine, drafting and Bonzo client share `@/`-aliased code with the
UI, and splitting them across runtimes would create drift. `pg_cron` ticks every
five minutes and `pg_net` POSTs to a Next.js route that imports them directly.

The one exception is the call reminder dispatcher, which is a Supabase Edge
Function: a single indexed query plus a Telegram send, no Anthropic SDK, no
shared domain code. If it ever needs the cadence engine, move it back into the
app rather than duplicating code.

### Background work

Work is queued in a `jobs` table rather than fanned out inside a request. Jobs
are claimed atomically with `for update skip locked`, retried with exponential
backoff to a cap of three attempts, and surfaced in Telegram when they exhaust
retries. Every handler is idempotent.

The worker drains a bounded batch, stops on a wall-clock budget under the
`pg_net` timeout, releases anything it did not reach, and chains if work
remains. Throughput comes from chaining, not from long invocations.

## Cost model

Roughly **$0.50 per hot lead per month**. That holds only because of these
rules, which are requirements rather than optimizations:

| Rule | Why |
|---|---|
| Polling never calls the model | ~1,000 refreshes/day are Bonzo reads only. The model sits behind an explicit `hasNewMessages` branch. Ignoring this is a 45x cost increase that would look reasonable in review. |
| Chunk size stays at 4 | A ~2,300-token stable prefix is resent per chunk. At 1 lead per chunk it dominates and roughly triples drafting cost. |
| Retries are capped at one | A failing draft is retried once, then surfaced flagged as unvalidated. An over-strict validator must degrade into showing something, not into burning tokens. |
| Prompts are cache-shaped | Stable prefix first in fixed order — system prompt, voice profile, style exemplars — with per-lead context strictly after. The `cache_control` breakpoint is commented at the boundary. |
| Models are routed by job | Judgment on Opus, drafting on Sonnet, extraction on Haiku. No model string is hardcoded. |

`user_settings.daily_token_budget` halts model calls when exceeded and sends one
Telegram warning. A runaway loop costs a notification, not an invoice.

## Development

```bash
npm install
cp .env.example .env.local   # then fill it in
npm run dev
```

```bash
npm test          # vitest
npx tsc --noEmit  # typecheck
npm run lint
```

Tests cover the parts where a silent error is expensive rather than loud:
cadence lane selection and the hold rule, timezone and DST handling, the
drafting validators, Bonzo's `incoming`/`outgoing` vocabulary, Telegram
callback idempotency, and the cost guards — including an assertion that a
refresh finding no new messages makes zero model calls.

The `for update skip locked` guarantee lives inside `claim_jobs()` and cannot
be exercised from TypeScript, so it is asserted two ways instead: that the app
claims through that single RPC rather than a read-then-write pair, and that
the migration defining it still says `skip locked`.

## Deploying from scratch

Steps 1–3 are one-time. Do them in order — the migrations skip work when their
prerequisites are absent and will need re-running.

### 1. Enable Postgres extensions

Supabase Dashboard → Database → Extensions. Enable `pg_cron`, `pg_net` and
`vault`. `pg_cron` may already be on; verify rather than assume. Do not try to
enable these from a migration.

### 2. Store secrets in Vault

Run in the SQL editor. These must never appear in a migration, since migrations
are committed.

```sql
select vault.create_secret('https://<your-app>.vercel.app', 'worker_url');
select vault.create_secret('<long random string>',          'worker_secret');
select vault.create_secret('https://<your-project>.supabase.co', 'functions_url');
select vault.create_secret('<a different long random string>',   'reminder_secret');
```

The cron jobs read these at execution time, so no URL or token is committed.

### 3. Set environment variables in Vercel

Everything in `.env.example`. `WORKER_SECRET` must be byte-identical to the
`worker_secret` vault value. Redeploy afterwards.

### 4. Push migrations

```bash
npx supabase db push
```

> **If your project predates this repo's migration history**, its schema was
> built by hand and `supabase_migrations.schema_migrations` is empty. The
> migrations are written to be idempotent and forward-only for exactly that
> case — `add column if not exists`, `alter type ... add value`, no drops — so
> they no-op safely against an existing database. Validate against a local
> stack or a branch first regardless.

### 5. Deploy the reminder Edge Function

```bash
npx supabase functions deploy call-reminders --no-verify-jwt
npx supabase secrets set REMINDER_SECRET=<the reminder_secret value> TELEGRAM_BOT_TOKEN=<your bot token>
```

`--no-verify-jwt` is required: `pg_cron` calls this with a bearer shared secret,
not a Supabase JWT, so platform verification would reject it before the function
runs.

Then re-run step 4 — the cron migration skips itself with a notice while Vault
is missing `reminder_secret` or `functions_url`, rather than scheduling a job
that fails every minute.

### 6. Register the Telegram webhook

Inspect first — this changes nothing:

```bash
npx tsx scripts/register-webhook.ts --info
```

Then point the bot at the deployment. `SITE_URL` is passed explicitly so a
local `.env.local` containing `http://localhost:3000` cannot silently aim the
live bot at a machine Telegram cannot reach:

```bash
SITE_URL=https://your-app.vercel.app npx tsx scripts/register-webhook.ts
```

`TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` must be in the environment.

Rotating the bot token does **not** clear the webhook — it is bound to the bot,
not the token — but re-register if the deployment URL changes.

## Verifying it works

From SQL alone:

```sql
select jobname, schedule, active from cron.job;
select jobname, status, start_time from cron.job_run_details order by start_time desc limit 10;
select status, count(*) from jobs group by status;
```

Two schedules should be active: `leadtracker-worker-tick` every five minutes and
`leadtracker-call-reminders` every minute.

**`cron.job_run_details.status = 'succeeded'` only means the SQL ran.** To see
what the endpoint actually returned:

```sql
select status_code, left(content, 200), created
from net._http_response order by created desc limit 10;
```

A `401` means a secret mismatch between Vault and the environment. `pg_net`
keeps response bodies for about six hours, so anything needed to diagnose a
failure a day later is written into `jobs.last_error` by the handler itself.

Supabase advises keeping concurrent cron jobs in the single digits and each job
under ten minutes. Two schedules, both finishing in well under a second, sits
comfortably inside that — but weigh any third addition.

## Authentication between Postgres and the app

Both the worker route and the reminder function authenticate with a plain
bearer shared secret read from Vault.

Deliberately **not** a JWT. Signing one inside Postgres would mean `pgjwt`
(deprecated in PG 17) or `pgsodium` (Supabase advises against new usage), and
the old static service-role-key approach is no longer surfaced by the CLI. If
you find yourself reaching for any of those, stop.
