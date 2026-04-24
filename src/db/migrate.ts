import { PAY_RAIL_PLACEHOLDER_SESSION_ID } from "../lib/pay-rail.js";
import type { SqliteDb } from "../types.js";

function tableExists(db: SqliteDb, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name) as { name: string } | undefined;
  return Boolean(row);
}

function planColumnSet(db: SqliteDb): Set<string> {
  if (!tableExists(db, "credit_plans")) {
    return new Set();
  }
  const cols = db.prepare(`PRAGMA table_info(credit_plans)`).all() as Array<{ name: string }>;
  return new Set(cols.map((c) => c.name));
}

/**
 * Oldest `credit_plans` had PRIMARY KEY (id) only. Rebuild with composite (id, chain_id) and
 * canonical amount/contract column names. No-op if `chain_id` or `tempo_chain_id` already present.
 */
function migrateCreditPlansCompositeKey(db: SqliteDb): void {
  if (!tableExists(db, "credit_plans")) {
    return;
  }
  const names = planColumnSet(db);
  if (names.has("chain_id") || names.has("tempo_chain_id")) {
    return;
  }

  db.exec(`
    CREATE TABLE credit_plans_new (
      id TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      credits REAL NOT NULL,
      token_amount TEXT NOT NULL,
      token_contract TEXT NOT NULL,
      token_decimals INTEGER NOT NULL DEFAULT 6,
      label TEXT NOT NULL,
      description TEXT NOT NULL,
      offer TEXT,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      token_symbol TEXT,
      rpc_url TEXT,
      recipient TEXT,
      PRIMARY KEY (id, chain_id)
    );
    INSERT INTO credit_plans_new (
      id, chain_id, credits, token_amount, token_contract, token_decimals,
      label, description, offer, active, sort_order, created_at, updated_at, token_symbol, rpc_url, recipient
    )
    SELECT id, 42431, credits, tempo_amount, tempo_currency, tempo_decimals,
      label, description, offer, active, sort_order, created_at, updated_at, NULL, NULL, NULL
    FROM credit_plans;
    DROP TABLE credit_plans;
    ALTER TABLE credit_plans_new RENAME TO credit_plans;
  `);
}

/** In-place renames: `tempo_*` → canonical names (SQLite 3.25+). */
function renameCreditPlansTempoToCanonical(db: SqliteDb): void {
  if (!tableExists(db, "credit_plans")) {
    return;
  }
  const names = planColumnSet(db);
  if (names.has("chain_id") || !names.has("tempo_chain_id")) {
    return;
  }
  db.exec(`DROP INDEX IF EXISTS idx_credit_plans_chain_active_sort`);
  db.exec(`ALTER TABLE credit_plans RENAME COLUMN tempo_chain_id TO chain_id`);
  if (names.has("tempo_amount")) {
    db.exec(`ALTER TABLE credit_plans RENAME COLUMN tempo_amount TO token_amount`);
  }
  if (names.has("tempo_currency")) {
    db.exec(`ALTER TABLE credit_plans RENAME COLUMN tempo_currency TO token_contract`);
  }
  if (names.has("tempo_decimals")) {
    db.exec(`ALTER TABLE credit_plans RENAME COLUMN tempo_decimals TO token_decimals`);
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_credit_plans_chain_active_sort ON credit_plans(chain_id, active, sort_order)`,
  );
}

function ensureCreditPlansChainIndex(db: SqliteDb): void {
  if (!tableExists(db, "credit_plans")) {
    return;
  }
  const names = planColumnSet(db);
  const ch = names.has("chain_id") ? "chain_id" : "tempo_chain_id";
  if (!names.has("chain_id") && !names.has("tempo_chain_id")) {
    return;
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_credit_plans_chain_active_sort ON credit_plans(${ch}, active, sort_order)`,
  );
}

function ensureApiKeysEmailIndex(db: SqliteDb): void {
  if (!tableExists(db, "api_keys")) {
    return;
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_email ON api_keys(email)`);
}

function transColumnSet(db: SqliteDb): Set<string> {
  if (!tableExists(db, "credit_transactions")) {
    return new Set();
  }
  const cols = db.prepare(`PRAGMA table_info(credit_transactions)`).all() as Array<{ name: string }>;
  return new Set(cols.map((c) => c.name));
}

function renameCreditTransactionsTempoToCanonical(db: SqliteDb): void {
  if (!tableExists(db, "credit_transactions")) {
    return;
  }
  const names0 = transColumnSet(db);
  if (!names0.has("tempo_tx_hash") && !names0.has("tempo_chain_id")) {
    if (names0.has("tx_hash")) {
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS ux_credit_transactions_tx_hash ON credit_transactions(tx_hash)`,
      );
    }
    return;
  }
  db.exec(`DROP INDEX IF EXISTS ux_credit_transactions_tempo_tx_hash`);
  db.exec(`DROP INDEX IF EXISTS ux_credit_transactions_tx_hash`);
  let names = names0;
  if (names.has("tempo_tx_hash") && !names.has("tx_hash")) {
    db.exec(`ALTER TABLE credit_transactions RENAME COLUMN tempo_tx_hash TO tx_hash`);
    names = transColumnSet(db);
  }
  if (names.has("tempo_chain_id") && !names.has("chain_id")) {
    db.exec(`ALTER TABLE credit_transactions RENAME COLUMN tempo_chain_id TO chain_id`);
  }
  if (transColumnSet(db).has("tx_hash")) {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_credit_transactions_tx_hash ON credit_transactions(tx_hash)`,
    );
  }
}

function ensureCreditPlansOptionalMetaColumns(db: SqliteDb): void {
  if (!tableExists(db, "credit_plans")) {
    return;
  }
  const names = planColumnSet(db);
  if (!names.has("token_symbol")) {
    db.exec(`ALTER TABLE credit_plans ADD COLUMN token_symbol TEXT`);
  }
  if (!names.has("rpc_url")) {
    db.exec(`ALTER TABLE credit_plans ADD COLUMN rpc_url TEXT`);
  }
  if (!names.has("recipient")) {
    db.exec(`ALTER TABLE credit_plans ADD COLUMN recipient TEXT`);
  }
}

function ensurePayRailPlaceholderSession(db: SqliteDb): void {
  if (!tableExists(db, "signup_sessions")) {
    return;
  }
  const row = db
    .prepare(`SELECT 1 AS ok FROM signup_sessions WHERE id = ?`)
    .get(PAY_RAIL_PLACEHOLDER_SESSION_ID) as { ok: number } | undefined;
  if (row) {
    return;
  }
  const now = "2020-01-01T00:00:00.000Z";
  db.prepare(
    `INSERT INTO signup_sessions (
       id, email, agent_name, session_token_hash, session_token_raw, user_code,
       status, created_at, expires_at, verified_at, credentials_delivered
     ) VALUES (?, ?, ?, ?, ?, ?, 'expired', ?, ?, ?, 1)`,
  ).run(
    PAY_RAIL_PLACEHOLDER_SESSION_ID,
    "system-placeholder@bds.internal",
    "pay-rail",
    "0".repeat(64),
    "pay-rail-placeholder",
    "BDS0-PAY0",
    now,
    now,
    now,
  );
}

function ensureApiKeysPayerAddress(db: SqliteDb): void {
  if (!tableExists(db, "api_keys")) {
    return;
  }
  const cols = db.prepare(`PRAGMA table_info(api_keys)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "payer_address")) {
    db.exec(`ALTER TABLE api_keys ADD COLUMN payer_address TEXT`);
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_api_keys_payer ON api_keys(payer_address) WHERE payer_address IS NOT NULL`,
  );
}

function ensureSignupPaymentQuotesTable(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS signup_payment_quotes (
      id TEXT PRIMARY KEY,
      signup_nonce_hash TEXT UNIQUE NOT NULL,
      signup_nonce_raw TEXT,
      agent_name TEXT NOT NULL,
      email TEXT,
      plan_id TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      token_contract TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      token_decimals INTEGER NOT NULL,
      amount_atomic TEXT NOT NULL,
      payer_address TEXT NOT NULL,
      recipient TEXT NOT NULL,
      terms_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      api_key_id TEXT,
      claim_tx_hash TEXT,
      FOREIGN KEY (api_key_id) REFERENCES api_keys(id)
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_quotes_pending_per_payer
      ON signup_payment_quotes(payer_address, plan_id, chain_id, consumed_at);
  `);
}

/** Apply additive / rename migrations (idempotent). */
export function migrateIfNeeded(db: SqliteDb): void {
  migrateCreditPlansCompositeKey(db);
  renameCreditPlansTempoToCanonical(db);
  ensureCreditPlansChainIndex(db);
  ensureCreditPlansOptionalMetaColumns(db);
  ensureApiKeysEmailIndex(db);
  ensurePayRailPlaceholderSession(db);
  ensureApiKeysPayerAddress(db);
  ensureSignupPaymentQuotesTable(db);

  const tcols = transColumnSet(db);
  if (tableExists(db, "credit_transactions")) {
    if (!tcols.has("plan_id")) {
      db.exec(`ALTER TABLE credit_transactions ADD COLUMN plan_id TEXT`);
    }
    if (!tcols.has("chain_id") && !tcols.has("tempo_chain_id")) {
      db.exec(`ALTER TABLE credit_transactions ADD COLUMN chain_id INTEGER`);
    }
  }
  renameCreditTransactionsTempoToCanonical(db);
}
