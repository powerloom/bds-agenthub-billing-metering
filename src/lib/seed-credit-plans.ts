import type { SqliteDb } from "../types.js";

/** Default row matching `defaultPlansBundle` in config (Moderato pathUSD). */
export const DEFAULT_CREDIT_PLAN_SEEDS: Array<{
  id: string;
  credits: number;
  tempo_amount: string;
  tempo_currency: string;
  tempo_decimals: number;
  label: string;
  description: string;
  offer: string | null;
  sort_order: number;
  tempo_chain_id: number;
}> = [
  {
    id: "launch_10",
    credits: 10,
    tempo_amount: "0.05",
    tempo_currency: "0x20c0000000000000000000000000000000000000",
    tempo_decimals: 6,
    tempo_chain_id: 42431,
    label: "10 credits — 1 full day (7200 epochs)",
    description:
      "Each credit = 720 epochs. allTrades, per-block aggregated snapshot. Ethereum mainnet ~12s block time.",
    offer: "launch_50pct_off",
    sort_order: 0,
  },
];

/**
 * Inserts default plans where `id` is missing (`INSERT OR IGNORE`).
 * Returns the number of rows inserted (0 if all ids already exist).
 */
export function seedDefaultCreditPlans(db: SqliteDb): number {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO credit_plans (
       id, tempo_chain_id, credits, tempo_amount, tempo_currency, tempo_decimals,
       label, description, offer, active, sort_order, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  );

  let inserted = 0;
  for (const p of DEFAULT_CREDIT_PLAN_SEEDS) {
    const info = stmt.run(
      p.id,
      p.tempo_chain_id,
      p.credits,
      p.tempo_amount,
      p.tempo_currency,
      p.tempo_decimals,
      p.label,
      p.description,
      p.offer,
      p.sort_order,
      now,
      now,
    );
    inserted += Number(info.changes ?? 0);
  }

  return inserted;
}
