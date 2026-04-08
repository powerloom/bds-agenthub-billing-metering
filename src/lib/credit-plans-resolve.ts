import type { AppConfig, CreditPlan, CreditPlansBundle } from "../config.js";
import type { SqliteDb } from "../types.js";

type CreditPlanRow = {
  id: string;
  tempo_chain_id: number;
  credits: number;
  tempo_amount: string;
  tempo_currency: string;
  tempo_decimals: number;
  label: string;
  description: string;
  offer: string | null;
  active: number;
};

/**
 * Resolved bundle for GET /credits/plans and Tempo top-up verification.
 *
 * - If `CREDIT_PLANS_SOURCE=env`, always uses `fallback` (CREDIT_PLANS_JSON / defaults).
 * - Else if `credit_plans` has rows for `fallback.tempo_chain_id`, those plans are used;
 *   `tempo_recipient`, `tempo_rpc_url`, `epoch_unit` still come from `fallback` (env).
 * - Else uses `fallback` only.
 */
export function resolveCreditPlansBundle(db: SqliteDb, config: AppConfig): CreditPlansBundle {
  const fallback = config.creditPlansFallback;
  if (config.creditPlansSource === "env") {
    return fallback;
  }

  const chain = fallback.tempo_chain_id;
  const rows = db
    .prepare(
      `SELECT id, tempo_chain_id, credits, tempo_amount, tempo_currency, tempo_decimals, label, description, offer, active
       FROM credit_plans
       WHERE tempo_chain_id = ?
       ORDER BY sort_order ASC, id ASC`,
    )
    .all(chain) as CreditPlanRow[];

  if (rows.length === 0) {
    return fallback;
  }

  const plans: CreditPlan[] = rows.map((r) => ({
    id: r.id,
    credits: r.credits,
    tempo_amount: r.tempo_amount,
    tempo_currency: r.tempo_currency,
    tempo_decimals: r.tempo_decimals,
    tempo_chain_id: r.tempo_chain_id,
    label: r.label,
    description: r.description,
    offer: r.offer ?? undefined,
    active: r.active === 1,
  }));

  return {
    plans,
    tempo_recipient: fallback.tempo_recipient,
    tempo_chain_id: fallback.tempo_chain_id,
    tempo_rpc_url: fallback.tempo_rpc_url,
    epoch_unit: fallback.epoch_unit,
  };
}
