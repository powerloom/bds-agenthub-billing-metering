import type { SqliteDb } from "../types.js";

/** Legacy credit_plans had PRIMARY KEY(id) only; rebuild with (id, tempo_chain_id). */
function migrateCreditPlansCompositeKey(db: SqliteDb): void {
  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='credit_plans'`)
    .get() as { name: string } | undefined;
  if (!exists) {
    return;
  }

  const cols = db.prepare(`PRAGMA table_info(credit_plans)`).all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (names.has("tempo_chain_id")) {
    return;
  }

  db.exec(`
    CREATE TABLE credit_plans_new (
      id TEXT NOT NULL,
      tempo_chain_id INTEGER NOT NULL,
      credits REAL NOT NULL,
      tempo_amount TEXT NOT NULL,
      tempo_currency TEXT NOT NULL,
      tempo_decimals INTEGER NOT NULL DEFAULT 6,
      label TEXT NOT NULL,
      description TEXT NOT NULL,
      offer TEXT,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (id, tempo_chain_id)
    );
    INSERT INTO credit_plans_new (
      id, tempo_chain_id, credits, tempo_amount, tempo_currency, tempo_decimals,
      label, description, offer, active, sort_order, created_at, updated_at
    )
    SELECT id, 42431, credits, tempo_amount, tempo_currency, tempo_decimals,
      label, description, offer, active, sort_order, created_at, updated_at
    FROM credit_plans;
    DROP TABLE credit_plans;
    ALTER TABLE credit_plans_new RENAME TO credit_plans;
  `);
}

function ensureCreditPlansChainIndex(db: SqliteDb): void {
  const t = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='credit_plans'`)
    .get() as { name: string } | undefined;
  if (!t) {
    return;
  }
  const cols = db.prepare(`PRAGMA table_info(credit_plans)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "tempo_chain_id")) {
    return;
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_credit_plans_chain_active_sort ON credit_plans(tempo_chain_id, active, sort_order)`,
  );
}

/** Apply additive migrations after schema.sql (idempotent). */
export function migrateIfNeeded(db: SqliteDb): void {
  migrateCreditPlansCompositeKey(db);
  ensureCreditPlansChainIndex(db);
  const cols = db.prepare(`PRAGMA table_info(credit_transactions)`).all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("tempo_chain_id")) {
    db.exec(`ALTER TABLE credit_transactions ADD COLUMN tempo_chain_id INTEGER`);
  }
  if (!names.has("plan_id")) {
    db.exec(`ALTER TABLE credit_transactions ADD COLUMN plan_id TEXT`);
  }

  const indexes = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'credit_transactions'`)
    .all() as Array<{ name: string }>;
  const indexNames = new Set(indexes.map((i) => i.name));
  if (!indexNames.has("ux_credit_transactions_tempo_tx_hash")) {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_credit_transactions_tempo_tx_hash ON credit_transactions(tempo_tx_hash)`,
    );
  }
}
