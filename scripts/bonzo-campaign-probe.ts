/**
 * Answers the two Phase 7 D3 questions the Bonzo OpenAPI document leaves open.
 *
 * There is no local Bonzo. The document lists a staging host, but that is
 * Bonzo's own environment and a normal API token does not reach it. Everything
 * here runs against production — Eddie's real CRM — which is why the write
 * phase is opt-in and defended rather than just prompted for.
 *
 * The open questions:
 *
 *   1. Does POST /v3/prospects/{prospect}/campaign/{campaign} APPEND to a
 *      prospect's campaigns or REPLACE them? The endpoint is titled "Move to
 *      campaign", but ApiProspectResource.campaigns is an array. If it
 *      replaces, a handoff silently pulls a lead out of everything else it was
 *      enrolled in.
 *
 *   2. Is enrollment recorded even for a prospect who cannot be messaged? This
 *      matters because it is what makes the write phase safe to run at all.
 *
 * Usage:
 *   npx tsx scripts/bonzo-campaign-probe.ts
 *       Read-only. Lists campaigns and looks for a prospect already sitting in
 *       two or more of them. If one exists, question 1 is largely answered for
 *       free — multi-enrollment is real — and you may not need the write phase.
 *
 *   npx tsx scripts/bonzo-campaign-probe.ts --write
 *       Creates one throwaway prospect, marks it DNC before touching any
 *       campaign, enrolls it in two campaigns in turn, and reports whether the
 *       second enrollment added to or replaced the first. Prints cleanup
 *       instructions; it does not delete anything itself.
 */

const TOKEN = process.env.BONZO_API_TOKEN;
const BASE = "https://app.getbonzo.com/api";
const WRITE = process.argv.includes("--write");

if (!TOKEN) {
  console.error(
    "BONZO_API_TOKEN is not set.\n" +
      "Run it with your local env loaded, e.g.:\n" +
      "  set -a && source .env.local && set +a && npx tsx scripts/bonzo-campaign-probe.ts"
  );
  process.exit(1);
}

interface Campaign {
  id: number;
  name: string;
  prospects_count?: string;
  sequence?: { id: number; name: string; enabled?: boolean };
}

interface SimpleCampaign {
  id: number;
  name: string;
  sequence_start?: string;
}

interface Prospect {
  id: number;
  full_name?: string;
  first_name?: string;
  campaigns?: SimpleCampaign[];
  do_not_call?: boolean;
}

class ScopeError extends Error {}

async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const hasBody = init.body !== undefined;
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/json",
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
  });

  const text = await res.text();
  if (res.status === 403 && text.includes("scope")) {
    throw new ScopeError(`${init.method ?? "GET"} ${path} → 403 Invalid scope(s)`);
  }
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}\n${text.slice(0, 500)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

function names(cs: SimpleCampaign[] | undefined): string {
  if (!cs || cs.length === 0) return "(none)";
  return cs.map((c) => `${c.name} [${c.id}]`).join(", ");
}

/**
 * Reports the token's scopes. Worth doing first: /v3/campaigns needs the
 * `campaigns` scope, which is not granted by default, and the 403 it returns
 * otherwise says only "Invalid scope(s) provided" with no hint which one.
 */
async function reportScopes(): Promise<string[]> {
  interface Token {
    name?: string;
    scopes?: string[];
    revoked?: boolean;
  }
  const raw = await api<Token[] | { data: Token[] }>(
    "/v3/oauth/personal-access-tokens"
  );
  const tokens = Array.isArray(raw) ? raw : raw.data;
  const live = tokens.filter((t) => !t.revoked);

  console.log("\n=== Token scopes ===");
  for (const t of live) {
    console.log(`  ${t.name ?? "(unnamed)"}: ${(t.scopes ?? []).join(", ") || "(none)"}`);
  }

  const all = new Set(live.flatMap((t) => t.scopes ?? []));
  if (!all.has("campaigns")) {
    console.log(
      "\n  ⚠ No token carries the `campaigns` scope. /v3/campaigns will 403,\n" +
        "    and campaign enrollment almost certainly will too. Create a new\n" +
        "    token in the Bonzo UI with `campaigns` added, then replace\n" +
        "    BONZO_API_TOKEN in .env.local and in Vercel."
    );
  }
  return [...all];
}

async function readOnlyPhase(): Promise<Campaign[]> {
  let campaigns: Campaign[] = [];
  let scopeBlocked = false;

  console.log("\n=== Campaigns ===");
  try {
    campaigns = (await api<{ data: Campaign[] }>("/v3/campaigns")).data;
  } catch (e) {
    if (!(e instanceof ScopeError)) throw e;
    scopeBlocked = true;
    console.log(
      "  Not readable — the token lacks the `campaigns` scope.\n" +
        "  Falling back to the campaigns visible on prospect records below,\n" +
        "  which come embedded in the prospect resource and need no extra scope."
    );
  }

  if (campaigns.length === 0 && !scopeBlocked) {
    console.log("No campaigns exist on this account. Create one in Bonzo first.");
  }

  for (const c of campaigns) {
    const seq = c.sequence
      ? `sequence "${c.sequence.name}" ${c.sequence.enabled === false ? "(DISABLED — safe to test with)" : "(enabled — will send)"}`
      : "no sequence attached (safe to test with)";
    console.log(`  [${c.id}] ${c.name} — ${c.prospects_count ?? "?"} prospects, ${seq}`);
  }

  // The free answer to question 1. Enrollment state is readable without
  // writing anything, so if any prospect already sits in two campaigns then
  // multi-enrollment is real and "Move" is very unlikely to be a replace.
  console.log("\n=== Looking for an existing multi-campaign prospect ===");
  const { data: prospects } = await api<{ data: Prospect[] }>("/v3/prospects");
  const multi = prospects.filter((p) => (p.campaigns?.length ?? 0) > 1);

  const dist = new Map<number, number>();
  const observed = new Map<number, string>();
  for (const p of prospects) {
    const n = p.campaigns?.length ?? 0;
    dist.set(n, (dist.get(n) ?? 0) + 1);
    for (const c of p.campaigns ?? []) observed.set(c.id, c.name);
  }

  console.log(`  Scanned ${prospects.length} prospects on the first page.`);
  console.log(
    "  Campaigns per prospect: " +
      [...dist.entries()].sort((a, b) => a[0] - b[0]).map(([n, c]) => `${n}→${c}`).join(", ")
  );
  if (observed.size > 0) {
    console.log("  Campaigns seen on those records:");
    for (const [cid, cname] of observed) console.log(`    [${cid}] ${cname}`);
  }
  if (multi.length > 0) {
    console.log(`  ${multi.length} are in more than one campaign. Examples:`);
    for (const p of multi.slice(0, 5)) {
      console.log(`    ${p.full_name ?? p.first_name ?? p.id}: ${names(p.campaigns)}`);
    }
    console.log(
      "\n  → A prospect can hold several campaigns at once, so the data model\n" +
        "    is append-shaped. This does not prove the POST appends, but a\n" +
        "    replace would be surprising given these rows exist."
    );
  } else {
    console.log(
      "\n  → Nobody is in more than one campaign. That is weak evidence FOR\n" +
        "    replace: combined with the endpoint being named \"Move to\n" +
        "    campaign\", it is what you would expect if enrolling always\n" +
        "    displaces. It is not proof — it may just mean nobody has ever\n" +
        "    been double-enrolled. Use --write to settle it."
    );
  }

  return campaigns;
}

async function writePhase(campaigns: Campaign[]) {
  if (campaigns.length < 2) {
    console.log(
      "\nCannot run the write phase: need at least two campaigns read from\n" +
        "/v3/campaigns, and " +
        campaigns.length +
        " were readable. If that is a scope problem, fix the token first —\n" +
        "enrolling almost certainly needs the same scope listing does."
    );
    return;
  }

  // Prefer campaigns whose sequence is disabled or absent: nothing can go out
  // even if the DNC flag were ignored.
  const ranked = [...campaigns].sort((a, b) => {
    const safe = (c: Campaign) => (!c.sequence || c.sequence.enabled === false ? 0 : 1);
    return safe(a) - safe(b);
  });
  const [first, second] = ranked;

  console.log("\n=== Write phase ===");
  console.log(`  Campaign A: [${first.id}] ${first.name}`);
  console.log(`  Campaign B: [${second.id}] ${second.name}`);

  const stamp = Date.now();
  console.log("\n  Creating a throwaway prospect…");
  const created = await api<{ data: Prospect }>("/v3/prospects/create", {
    method: "POST",
    body: {
      first_name: "ZZ-ProbeDoNotContact",
      last_name: String(stamp),
      // No phone and no email: there is no address for a sequence to send to,
      // which is the strongest guarantee available here.
      type: "prospect",
    },
  });

  const id = created.data.id;
  console.log(`  Created prospect ${id}.`);

  // Belt and braces before any campaign call. DNC first, so that even if a
  // sequence somehow resolved a channel, Bonzo's own compliance layer blocks it.
  console.log("  Marking DNC before touching any campaign…");
  await api(`/v3/prospects/${id}/dnc`, { method: "POST", body: { value: true } });

  const before = await api<{ data: Prospect }>(`/v3/prospects/${id}`);
  console.log(`  Campaigns at start: ${names(before.data.campaigns)}`);

  console.log(`\n  Enrolling in A [${first.id}]…`);
  await api(`/v3/prospects/${id}/campaign/${first.id}`, { method: "POST" });
  const afterA = await api<{ data: Prospect }>(`/v3/prospects/${id}`);
  console.log(`  Campaigns now: ${names(afterA.data.campaigns)}`);

  console.log(`\n  Enrolling in B [${second.id}]…`);
  await api(`/v3/prospects/${id}/campaign/${second.id}`, { method: "POST" });
  const afterB = await api<{ data: Prospect }>(`/v3/prospects/${id}`);
  console.log(`  Campaigns now: ${names(afterB.data.campaigns)}`);

  const ids = (afterB.data.campaigns ?? []).map((c) => c.id);
  console.log("\n=== ANSWER ===");
  if (ids.includes(first.id) && ids.includes(second.id)) {
    console.log("  APPENDS. Both campaigns are present after the second call.");
    console.log("  → A handoff will not pull a lead out of its other campaigns.");
  } else if (ids.includes(second.id) && !ids.includes(first.id)) {
    console.log("  REPLACES. Only the second campaign survived.");
    console.log(
      "  → A handoff silently removes a lead from everything else it was in.\n" +
        "    The workflow action must read the current campaigns first and warn,\n" +
        "    or the seed workflow must never fire on an already-enrolled lead."
    );
  } else {
    console.log(`  INCONCLUSIVE. Campaign ids after both calls: [${ids.join(", ")}]`);
  }

  console.log(
    `\n  Cleanup: prospect ${id} ("ZZ-ProbeDoNotContact ${stamp}") is still in\n` +
      `  Bonzo, DNC'd and with no contact details. Delete it from the Bonzo UI\n` +
      `  when you are done looking at it.`
  );
}

async function main() {
  console.log(
    WRITE
      ? "Running READ + WRITE against PRODUCTION Bonzo."
      : "Running READ-ONLY against production Bonzo. Nothing will be modified."
  );

  await reportScopes();
  const campaigns = await readOnlyPhase();

  if (!WRITE) {
    console.log(
      "\nRe-run with --write to settle append-vs-replace definitively.\n" +
        "That creates one throwaway prospect with no phone and no email, marks\n" +
        "it DNC before any campaign call, and enrolls it in two campaigns."
    );
    return;
  }

  await writePhase(campaigns);
}

main().catch((e) => {
  console.error("\nFailed:", e instanceof Error ? e.message : e);
  process.exit(1);
});

export {};
