/**
 * Local operator CLI for SQLite billing data: credit_plans + per-key rate limits.
 *
 *   DB_PATH=./data/signup.db npm run admin              (interactive menu)
 *   DB_PATH=./data/signup.db npm run admin -- help
 *   DB_PATH=./data/signup.db npm run admin -- plan wizard
 *   DB_PATH=./data/signup.db npm run admin -- key rlimits   (prompts for id, rpm, rpd)
 */
import "dotenv/config";
import fs from "node:fs";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { openDb } from "../db/client.js";
import type { SqliteDb } from "../types.js";

const dbPath = process.env.DB_PATH ?? "./data/signup.db";
const NATIVE_PLACEHOLDER = "0x0000000000000000000000000000000000000000";

type PlanRow = {
  id: string;
  chain_id: number;
  credits: number;
  token_amount: string;
  token_contract: string;
  token_decimals: number;
  label: string;
  description: string;
  offer: string | null;
  active: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
  token_symbol: string | null;
  rpc_url: string | null;
  recipient: string | null;
  payment_kind: string;
};

type PlanUpsert = {
  id: string;
  chain_id: number;
  credits: number;
  token_amount: string;
  token_contract: string;
  token_decimals: number;
  label: string;
  description: string;
  offer?: string | null;
  sort_order: number;
  active?: 0 | 1;
  token_symbol: string;
  rpc_url?: string | null;
  recipient?: string | null;
  payment_kind?: "erc20" | "native_value";
};

function fail(msg: string): never {
  console.error(`[billing-admin] ${msg}`);
  process.exit(1);
}

async function ask(rl: readline.Interface, q: string, def?: string): Promise<string> {
  const hint = def !== undefined && def !== "" ? ` [${def}]` : def === "" ? " [empty]" : "";
  const line = (await rl.question(`  ${q}${hint}: `)).trim();
  if (line === "" && def !== undefined) return def;
  return line;
}

function parseJsonPlan(raw: string): PlanUpsert {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    fail("invalid JSON");
  }
  if (!o || typeof o !== "object") fail("JSON must be an object");
  const p = o as Record<string, unknown>;
  const id = p.id;
  const chain_id = p.chain_id;
  const credits = p.credits;
  const token_amount = p.token_amount;
  const token_contract = p.token_contract;
  const token_decimals = p.token_decimals;
  const label = p.label;
  const description = p.description;
  const sort_order = p.sort_order;
  const token_symbol = p.token_symbol;
  if (typeof id !== "string" || !id) fail("plan: id (string) required");
  if (typeof chain_id !== "number" || !Number.isInteger(chain_id)) fail("plan: chain_id (integer) required");
  if (typeof credits !== "number" || !Number.isFinite(credits)) fail("plan: credits (number) required");
  if (typeof token_amount !== "string") fail("plan: token_amount (string) required");
  if (typeof token_contract !== "string" || !token_contract.startsWith("0x")) {
    fail("plan: token_contract (0x... string) required");
  }
  if (typeof token_decimals !== "number" || !Number.isInteger(token_decimals) || token_decimals < 0) {
    fail("plan: token_decimals (non-negative int) required");
  }
  if (typeof label !== "string") fail("plan: label (string) required");
  if (typeof description !== "string") fail("plan: description (string) required");
  if (typeof sort_order !== "number" || !Number.isInteger(sort_order)) fail("plan: sort_order (int) required");
  if (typeof token_symbol !== "string" || !token_symbol) fail("plan: token_symbol (string) required");
  const offer = p.offer === undefined || p.offer === null ? null : p.offer;
  if (offer !== null && typeof offer !== "string") fail("plan: offer must be string or null");
  let active: 0 | 1 = 1;
  if (p.active !== undefined) {
    if (p.active !== 0 && p.active !== 1) fail("plan: active must be 0 or 1");
    active = p.active;
  }
  const rpc_url =
    p.rpc_url === undefined || p.rpc_url === null
      ? null
      : typeof p.rpc_url === "string"
        ? p.rpc_url
        : fail("plan: rpc_url must be string or null");
  const recipient =
    p.recipient === undefined || p.recipient === null
      ? null
      : typeof p.recipient === "string"
        ? p.recipient
        : fail("plan: recipient must be string or null");
  const pk = p.payment_kind;
  const payment_kind: "erc20" | "native_value" =
    pk === undefined || pk === "erc20" ? "erc20" : pk === "native_value" ? "native_value" : fail("plan: payment_kind must be erc20 or native_value");

  return {
    id,
    chain_id,
    credits,
    token_amount,
    token_contract,
    token_decimals,
    label,
    description,
    offer,
    sort_order,
    active,
    token_symbol,
    rpc_url,
    recipient,
    payment_kind,
  };
}

function planList(db: SqliteDb) {
  const rows = db
    .prepare(
      `SELECT id, chain_id, credits, token_amount, token_symbol, label, active, sort_order, payment_kind
       FROM credit_plans
       ORDER BY chain_id, sort_order, id`,
    )
    .all() as Array<{
      id: string;
      chain_id: number;
      credits: number;
      token_amount: string;
      token_symbol: string | null;
      label: string;
      active: number;
      sort_order: number;
      payment_kind: string;
    }>;
  if (rows.length === 0) {
    console.log("no credit_plans rows");
    return;
  }
  const pad = (s: string, w: number) => (s.length >= w ? s : s + " ".repeat(w - s.length));
  const header = [pad("id", 28), pad("chain", 6), pad("credits", 8), pad("sym", 8), pad("act", 4), pad("kind", 14), "label"].join("  ");
  console.log(header);
  console.log("-".repeat(Math.min(120, header.length)));
  for (const r of rows) {
    console.log(
      [
        pad(r.id, 28),
        pad(String(r.chain_id), 6),
        pad(String(r.credits), 8),
        pad((r.token_symbol ?? "").slice(0, 8), 8),
        pad(String(r.active), 4),
        pad(r.payment_kind, 14),
        r.label.slice(0, 80) + (r.label.length > 80 ? "…" : ""),
      ].join("  "),
    );
  }
}

function planGet(db: SqliteDb, id: string, chainId: number) {
  const row = db.prepare(`SELECT * FROM credit_plans WHERE id = ? AND chain_id = ?`).get(id, chainId) as PlanRow | undefined;
  if (!row) fail(`no plan (id=${id}, chain_id=${chainId})`);
  console.log(JSON.stringify(row, null, 2));
}

function planSetActive(db: SqliteDb, id: string, chainId: number, active: 0 | 1) {
  const now = new Date().toISOString();
  const info = db
    .prepare(`UPDATE credit_plans SET active = ?, updated_at = ? WHERE id = ? AND chain_id = ?`)
    .run(active, now, id, chainId);
  if (info.changes === 0) fail(`no plan (id=${id}, chain_id=${chainId})`);
  console.error(`[billing-admin] set active=${active} for ${id}@${chainId}`);
}

function planUpsert(db: SqliteDb, p: PlanUpsert) {
  const now = new Date().toISOString();
  const existing = db.prepare(`SELECT created_at FROM credit_plans WHERE id = ? AND chain_id = ?`).get(p.id, p.chain_id) as
    | { created_at: string }
    | undefined;
  const created_at = existing?.created_at ?? now;
  const kind = p.payment_kind;
  if (existing) {
    db.prepare(
      `UPDATE credit_plans SET
         credits = ?, token_amount = ?, token_contract = ?, token_decimals = ?,
         label = ?, description = ?, offer = ?, active = ?, sort_order = ?, updated_at = ?,
         token_symbol = ?, rpc_url = ?, recipient = ?, payment_kind = ?
       WHERE id = ? AND chain_id = ?`,
    ).run(
      p.credits,
      p.token_amount,
      p.token_contract,
      p.token_decimals,
      p.label,
      p.description,
      p.offer ?? null,
      p.active ?? 1,
      p.sort_order,
      now,
      p.token_symbol,
      p.rpc_url ?? null,
      p.recipient ?? null,
      kind,
      p.id,
      p.chain_id,
    );
    console.error(`[billing-admin] updated plan ${p.id}@${p.chain_id}`);
  } else {
    db.prepare(
      `INSERT INTO credit_plans (
         id, chain_id, credits, token_amount, token_contract, token_decimals,
         label, description, offer, active, sort_order, created_at, updated_at,
         token_symbol, rpc_url, recipient, payment_kind
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.id,
      p.chain_id,
      p.credits,
      p.token_amount,
      p.token_contract,
      p.token_decimals,
      p.label,
      p.description,
      p.offer ?? null,
      p.active ?? 1,
      p.sort_order,
      created_at,
      now,
      p.token_symbol,
      p.rpc_url ?? null,
      p.recipient ?? null,
      kind,
    );
    console.error(`[billing-admin] inserted plan ${p.id}@${p.chain_id}`);
  }
}

function planDelete(db: SqliteDb, id: string, chainId: number) {
  const info = db.prepare(`DELETE FROM credit_plans WHERE id = ? AND chain_id = ?`).run(id, chainId);
  if (info.changes === 0) fail(`no plan (id=${id}, chain_id=${chainId})`);
  console.error(`[billing-admin] deleted plan ${id}@${chainId}`);
}

function keyList(db: SqliteDb) {
  const rows = db
    .prepare(
      `SELECT id, email, org_id, rate_limit_rpm, rate_limit_rpd, credit_balance,
              CASE WHEN revoked_at IS NULL THEN 0 ELSE 1 END AS revoked, created_at
       FROM api_keys
       ORDER BY created_at DESC
       LIMIT 200`,
    )
    .all() as Array<{
      id: string;
      email: string;
      org_id: string;
      rate_limit_rpm: number;
      rate_limit_rpd: number;
      credit_balance: number;
      revoked: number;
      created_at: string;
    }>;
  if (rows.length === 0) {
    console.log("no api_keys rows");
    return;
  }
  const pad = (s: string, w: number) => (s.length >= w ? s : s + " ".repeat(w - s.length));
  const head = [pad("id", 12), pad("email", 28), pad("rpm", 5), pad("rpd", 6), pad("bal", 8), "rev", "created"].join("  ");
  console.log(head);
  console.log("-".repeat(100));
  for (const r of rows) {
    console.log(
      [
        pad(r.id.slice(0, 12), 12),
        pad((r.email ?? "").slice(0, 28), 28),
        pad(String(r.rate_limit_rpm), 5),
        pad(String(r.rate_limit_rpd), 6),
        pad(String(r.credit_balance), 8),
        String(r.revoked),
        r.created_at,
      ].join("  "),
    );
  }
  if (rows.length === 200) console.error("[billing-admin] (showing first 200 keys only)");
}

function keyRlimits(db: SqliteDb, id: string, rpm: number, rpd: number) {
  if (!Number.isInteger(rpm) || rpm < 1) fail("rpm must be a positive integer");
  if (!Number.isInteger(rpd) || rpd < 1) fail("rpd must be a positive integer");
  const info = db.prepare(`UPDATE api_keys SET rate_limit_rpm = ?, rate_limit_rpd = ? WHERE id = ?`).run(rpm, rpd, id);
  if (info.changes === 0) fail(`no api_key with id ${id}`);
  console.error(`[billing-admin] set rate limits for ${id}: rpm=${rpm} rpd=${rpd}`);
}

function printHelp() {
  console.log(`bds-agenthub-billing-metering — billing admin (SQLite)

Uses DB_PATH (default ${JSON.stringify("./data/signup.db")}).
Current DB_PATH: ${dbPath}

Interactive:
  (no subcommand)        — same as: menu
  menu | interactive | i — guided menu
  plan wizard            — add/edit one credit_plans row (step-by-step; no JSON)
  key rlimits            — with no id: prompts for api_key uuid, rpm, rpd
                          (or: key rlimits <id> <rpm> <rpd>)

Non-interactive (scripts / CI):
  plan list
  plan get <id> <chain_id>
  plan set-active <id> <chain_id> <0|1>
  plan upsert <file.json>   (or "-" to read JSON from stdin)
  plan delete <id> <chain_id>
  key list
  key rlimits <api_key_id> <rpm> <rpd>
`);
}

async function readPaymentKind(rl: readline.Interface, dflt: "erc20" | "native_value"): Promise<"erc20" | "native_value"> {
  const line = (await ask(rl, "Payment kind — 1=erc20 (token transfer) 2=native (tx.value / CGT)", dflt === "erc20" ? "1" : "2")).toLowerCase();
  if (line === "1" || line === "erc20") return "erc20";
  if (line === "2" || line === "native" || line === "native_value") return "native_value";
  if (line === "" && dflt) return dflt;
  return dflt;
}

function rowToPlanUpsert(r: PlanRow): PlanUpsert {
  return {
    id: r.id,
    chain_id: r.chain_id,
    credits: r.credits,
    token_amount: r.token_amount,
    token_contract: r.token_contract,
    token_decimals: r.token_decimals,
    label: r.label,
    description: r.description,
    offer: r.offer,
    sort_order: r.sort_order,
    active: (r.active === 0 ? 0 : 1) as 0 | 1,
    token_symbol: r.token_symbol ?? "",
    rpc_url: r.rpc_url,
    recipient: r.recipient,
    payment_kind: r.payment_kind === "native_value" ? "native_value" : "erc20",
  };
}

/** Guided prompts; loads existing row by (id, chain_id) for defaults. */
async function runPlanWizard(rl: readline.Interface, db: SqliteDb) {
  console.log("\n— Credit plan (add or overwrite row with same id+chain) —\n");
  const id0 = await ask(rl, "Plan id (string identifier)", "");
  if (!id0) {
    console.log("Aborted (empty id).");
    return;
  }
  const chainStr = await ask(rl, "EIP-155 chain_id (integer)", "1");
  const chainId = parseInt(chainStr, 10);
  if (!Number.isInteger(chainId)) {
    console.log("Aborted: chain_id must be an integer.");
    return;
  }

  const existing = db.prepare(`SELECT * FROM credit_plans WHERE id = ? AND chain_id = ?`).get(id0, chainId) as PlanRow | undefined;
  const d = existing ? rowToPlanUpsert(existing) : null;
  if (d) {
    console.log(`\nFound existing row — press Enter to keep [bracketed] default on each line.\n`);
  } else {
    console.log(`\nNo row for (${id0}, ${chainId}) — creating new plan.\n`);
  }

  const kind = await readPaymentKind(rl, d?.payment_kind ?? "erc20");

  const creditsStr = await ask(rl, "Credits included in this pack", d ? String(d.credits) : "10");
  const credits = parseFloat(creditsStr);
  if (!Number.isFinite(credits) || credits <= 0) {
    console.log("Aborted: credits must be a positive number.");
    return;
  }

  const tokenSymbol = await ask(rl, "Token symbol (display, e.g. USDC, POWER)", d?.token_symbol ?? "");
  if (!tokenSymbol) {
    console.log("Aborted: token_symbol required.");
    return;
  }

  const decStr = await ask(rl, "Token decimals (e.g. 6 for USDC, 18 for many ERC-20s)", d ? String(d.token_decimals) : "6");
  const token_decimals = parseInt(decStr, 10);
  if (!Number.isInteger(token_decimals) || token_decimals < 0) {
    console.log("Aborted: bad decimals.");
    return;
  }

  const token_amount = await ask(rl, "Price: human token amount (string, same units as decimals)", d?.token_amount ?? "");
  if (!token_amount) {
    console.log("Aborted: token_amount required.");
    return;
  }

  let token_contract: string;
  if (kind === "native_value") {
    const tc = await ask(rl, "Contract address (use all-zero for native / CGT placeholder)", d?.token_contract ?? NATIVE_PLACEHOLDER);
    token_contract = tc && tc.startsWith("0x") ? tc : NATIVE_PLACEHOLDER;
  } else {
    const tc = await ask(rl, "ERC-20 contract (0x…)", d?.token_contract ?? "");
    if (!tc || !tc.startsWith("0x")) {
      console.log("Aborted: erc20 needs a 0x contract.");
      return;
    }
    token_contract = tc;
  }

  const label = await ask(rl, "Label (one-line title in UI/CLI)", d?.label ?? "");
  if (!label) {
    console.log("Aborted: label required.");
    return;
  }
  const description = await ask(rl, "Description", d?.description ?? "");
  if (!description) {
    console.log("Aborted: description required.");
    return;
  }
  const offerIn = await ask(rl, "Offer code (or empty for none)", d?.offer ?? "");
  const offer: string | null = offerIn === "" ? null : offerIn;
  const sortStr = await ask(rl, "Sort order (integer, lower first)", d ? String(d.sort_order) : "0");
  const sort_order = parseInt(sortStr, 10);
  if (!Number.isInteger(sort_order)) {
    console.log("Aborted: sort_order must be an integer.");
    return;
  }
  const actIn = await ask(rl, "Active — 1=yes 0=hidden", d ? String(d.active ?? 1) : "1");
  const active: 0 | 1 = actIn === "0" ? 0 : 1;

  const rpc = await ask(rl, "Override rpc_url (empty = use PAYMENT_CHAINS from env on server)", d?.rpc_url ?? "");
  const rpc_url = rpc === "" ? null : rpc;
  const rec = await ask(rl, "Override recipient (empty = use chain config on server)", d?.recipient ?? "");
  const recipient = rec === "" ? null : rec;

  const plan: PlanUpsert = {
    id: id0,
    chain_id: chainId,
    credits,
    token_amount,
    token_contract,
    token_decimals,
    label,
    description,
    offer,
    sort_order,
    active,
    token_symbol: tokenSymbol,
    rpc_url,
    recipient,
    payment_kind: kind,
  };

  console.log("\n— Summary (JSON) —\n");
  console.log(JSON.stringify({ ...plan, _note: "payment_kind native_value = verify with tx.value" }, null, 2));
  const y = (await ask(rl, "Write to database? (y/N)", "n")).toLowerCase();
  if (y !== "y" && y !== "yes") {
    console.log("Skipped.");
    return;
  }
  planUpsert(db, plan);
  console.log("Done.\n");
}

async function runInteractiveRlimits(rl: readline.Interface, db: SqliteDb) {
  console.log("\n— Set advertised rate limits (api_keys.rate_limit_rpm / rpd) —\n");
  const id = await ask(rl, "api_key id (UUID from `key list`)", "");
  if (!id) {
    console.log("Aborted.");
    return;
  }
  const rps = await ask(rl, "Requests per minute (integer)", "60");
  const rds = await ask(rl, "Requests per day (integer)", "1000");
  const rpm = parseInt(rps, 10);
  const rpd = parseInt(rds, 10);
  if (!Number.isInteger(rpm) || !Number.isInteger(rpd)) {
    console.log("Aborted: rpm and rpd must be integers.");
    return;
  }
  const y = (await ask(rl, "Apply?", "n")).toLowerCase();
  if (y !== "y" && y !== "yes") {
    console.log("Skipped.");
    return;
  }
  keyRlimits(db, id, rpm, rpd);
}

async function runInteractiveSetActive(rl: readline.Interface, db: SqliteDb) {
  const id = await ask(rl, "Plan id", "");
  const cStr = await ask(rl, "chain_id", "");
  const aStr = await ask(rl, "Active 1=on 0=off", "1");
  const chain = parseInt(cStr, 10);
  if (!id || !Number.isInteger(chain)) {
    console.log("Aborted.");
    return;
  }
  if (aStr !== "0" && aStr !== "1") {
    console.log("Aborted: last arg must be 0 or 1.");
    return;
  }
  planSetActive(db, id, chain, aStr === "1" ? 1 : 0);
}

async function runInteractiveDeletePlan(rl: readline.Interface, db: SqliteDb) {
  const id = await ask(rl, "Plan id to DELETE", "");
  const cStr = await ask(rl, "chain_id", "");
  const chain = parseInt(cStr, 10);
  if (!id || !Number.isInteger(chain)) {
    console.log("Aborted.");
    return;
  }
  const y = (await ask(rl, "Type yes to delete", "n")).toLowerCase();
  if (y !== "yes") {
    console.log("Skipped.");
    return;
  }
  planDelete(db, id, chain);
}

async function runMenu(db: SqliteDb) {
  const rl = readline.createInterface({ input, output });
  try {
    for (;;) {
      console.log(`
— billing admin —  DB: ${dbPath} —

  1) List credit plans
  2) Add / edit plan (wizard)
  3) Set plan active (0/1)
  4) Delete a plan
  5) List API keys
  6) Set key rate limits (rpm / rpd)
  h) Help (non-interactive commands)
  q) Quit

Tip: for scripts use \`npm run admin -- plan list\` etc.
`);
      const c = (await rl.question("Choice: ")).trim().toLowerCase();
      if (c === "q" || c === "quit") break;
      if (c === "1") {
        planList(db);
      } else if (c === "2") {
        await runPlanWizard(rl, db);
      } else if (c === "3") {
        await runInteractiveSetActive(rl, db);
      } else if (c === "4") {
        await runInteractiveDeletePlan(rl, db);
      } else if (c === "5") {
        keyList(db);
      } else if (c === "6") {
        await runInteractiveRlimits(rl, db);
      } else if (c === "h" || c === "help") {
        printHelp();
      } else {
        console.log("Unknown choice. Press h for help.\n");
      }
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "help" || argv[0] === "-h" || argv[0] === "--help") {
    printHelp();
    process.exit(0);
  }

  const db = openDb(dbPath);
  const cmd = argv[0];
  const a1 = argv[1];
  const a2 = argv[2];
  const a3 = argv[3];
  const a4 = argv[4];

  try {
    if (argv.length === 0 || cmd === "menu" || cmd === "interactive" || cmd === "i") {
      await runMenu(db);
    } else if (cmd === "plan" && a1 === "list") {
      planList(db);
    } else if (cmd === "plan" && a1 === "get" && a2 && a3 !== undefined) {
      const chain = Number(a3);
      if (!Number.isInteger(chain)) fail("chain_id must be an integer");
      planGet(db, a2, chain);
    } else if (cmd === "plan" && a1 === "set-active" && a2 && a3 !== undefined && a4 !== undefined) {
      const chain = Number(a3);
      if (!Number.isInteger(chain)) fail("chain_id must be an integer");
      if (a4 !== "0" && a4 !== "1") fail("active must be 0 or 1");
      planSetActive(db, a2, chain, a4 === "1" ? 1 : 0);
    } else if (cmd === "plan" && a1 === "wizard") {
      const rl = readline.createInterface({ input, output });
      try {
        await runPlanWizard(rl, db);
      } finally {
        rl.close();
      }
    } else if (cmd === "plan" && a1 === "upsert" && a2) {
      const raw = a2 === "-" ? fs.readFileSync(0, "utf-8") : fs.readFileSync(a2, "utf-8");
      const plan = parseJsonPlan(raw);
      planUpsert(db, plan);
    } else if (cmd === "plan" && a1 === "delete" && a2 && a3 !== undefined) {
      const chain = Number(a3);
      if (!Number.isInteger(chain)) fail("chain_id must be an integer");
      planDelete(db, a2, chain);
    } else if (cmd === "key" && a1 === "list") {
      keyList(db);
    } else if (cmd === "key" && a1 === "rlimits" && a2 && a3 !== undefined && a4 !== undefined) {
      const rpm = Number(a3);
      const rpd = Number(a4);
      if (!Number.isInteger(rpm) || !Number.isInteger(rpd)) fail("rpm and rpd must be integers");
      keyRlimits(db, a2, rpm, rpd);
    } else if (cmd === "key" && a1 === "rlimits" && a2 === undefined) {
      const rl = readline.createInterface({ input, output });
      try {
        await runInteractiveRlimits(rl, db);
      } finally {
        rl.close();
      }
    } else {
      printHelp();
      process.exit(1);
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
