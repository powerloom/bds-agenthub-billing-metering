/**
 * Local operator CLI for SQLite billing data: credit_plans + per-key rate limits.
 *
 *   DB_PATH=./data/signup.db npm run admin -- plan list
 *   DB_PATH=./data/signup.db npm run admin -- key rlimits <api_key_id> 120 2000
 *   DB_PATH=./data/signup.db npm run admin -- plan upsert ./my-plan.json
 */
import "dotenv/config";
import fs from "node:fs";
import { openDb } from "../db/client.js";
import type { SqliteDb } from "../types.js";

const dbPath = process.env.DB_PATH ?? "./data/signup.db";

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

Commands:
  plan list
  plan get <id> <chain_id>
  plan set-active <id> <chain_id> <0|1>
  plan upsert <file.json>   (or use "-" to read JSON from stdin)
  plan delete <id> <chain_id>

  key list
  key rlimits <api_key_id> <rpm> <rpd>
`);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "-h" || argv[0] === "--help") {
    printHelp();
    process.exit(0);
  }

  const db = openDb(dbPath);
  try {
    const [a0, a1, a2, a3, a4] = argv;

    if (a0 === "plan" && a1 === "list") {
      planList(db);
    } else if (a0 === "plan" && a1 === "get" && a2 && a3 !== undefined) {
      const chain = Number(a3);
      if (!Number.isInteger(chain)) fail("chain_id must be an integer");
      planGet(db, a2, chain);
    } else if (a0 === "plan" && a1 === "set-active" && a2 && a3 !== undefined && a4 !== undefined) {
      const chain = Number(a3);
      if (!Number.isInteger(chain)) fail("chain_id must be an integer");
      if (a4 !== "0" && a4 !== "1") fail("active must be 0 or 1");
      planSetActive(db, a2, chain, a4 === "1" ? 1 : 0);
    } else if (a0 === "plan" && a1 === "upsert" && a2) {
      const raw = a2 === "-" ? fs.readFileSync(0, "utf-8") : fs.readFileSync(a2, "utf-8");
      const plan = parseJsonPlan(raw);
      planUpsert(db, plan);
    } else if (a0 === "plan" && a1 === "delete" && a2 && a3 !== undefined) {
      const chain = Number(a3);
      if (!Number.isInteger(chain)) fail("chain_id must be an integer");
      planDelete(db, a2, chain);
    } else if (a0 === "key" && a1 === "list") {
      keyList(db);
    } else if (a0 === "key" && a1 === "rlimits" && a2 && a3 !== undefined && a4 !== undefined) {
      const rpm = Number(a3);
      const rpd = Number(a4);
      if (!Number.isInteger(rpm) || !Number.isInteger(rpd)) fail("rpm and rpd must be integers");
      keyRlimits(db, a2, rpm, rpd);
    } else {
      printHelp();
      process.exit(1);
    }
  } finally {
    db.close();
  }
}

main();
