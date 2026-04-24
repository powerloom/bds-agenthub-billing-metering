import type { AppConfig, CreditPlan, CreditPlansBundle } from "../config.js";
import { getPrimaryPaymentChain } from "../config.js";
import { redactRpcUrlForClient } from "./rpc-redact.js";
import type { SqliteDb } from "../types.js";

type CreditPlanRow = {
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
  token_symbol: string | null;
  rpc_url: string | null;
  recipient: string | null;
};

function toPublicChains(config: AppConfig): CreditPlansBundle["chains"] {
  return config.paymentChains.map((c) => ({
    chain_id: c.chain_id,
    rpc_url: redactRpcUrlForClient(c.rpc_url),
    recipient: c.recipient,
  }));
}

function primaryBundleFields(config: AppConfig): Pick<CreditPlansBundle, "primary_recipient" | "primary_chain_id" | "primary_rpc_url"> {
  const primary = getPrimaryPaymentChain(config);
  return {
    primary_recipient: primary.recipient,
    primary_chain_id: primary.chain_id,
    primary_rpc_url: redactRpcUrlForClient(primary.rpc_url),
  };
}

/**
 * Merges plans with `config` metadata for GET /credits/plans.
 */
function finalizeBundle(base: CreditPlansBundle, config: AppConfig, plans: CreditPlan[]): CreditPlansBundle {
  return {
    ...base,
    plans,
    chains: toPublicChains(config),
    terms_url: config.termsUrl,
    terms_version: config.termsVersion,
    ...primaryBundleFields(config),
  };
}

/**
 * Resolved bundle for GET /credits/plans and on-chain top-up verification.
 *
 * - If `CREDIT_PLANS_SOURCE=env`, always uses `creditPlansFallback` (CREDIT_PLANS_JSON / defaults).
 * - Else: active `credit_plans` rows whose `chain_id` is in configured payment chains (or the
 *   synthesized single chain from TEMPO_* when unset), ordered by `sort_order`, `id`.
 *   If that query is empty, uses `creditPlansFallback` only.
 * - `primary_recipient` / `primary_chain_id` / `primary_rpc_url` reflect the **primary** chain
 *   (`PAYMENT_CHAINS_PRIMARY_ID`, default `TEMPO_CHAIN_ID`).
 */
export function resolveCreditPlansBundle(db: SqliteDb, config: AppConfig): CreditPlansBundle {
  const fallback = config.creditPlansFallback;
  if (config.creditPlansSource === "env") {
    return finalizeBundle(fallback, config, fallback.plans);
  }

  const allowed = config.paymentChains.map((c) => c.chain_id);
  if (allowed.length === 0) {
    return finalizeBundle(fallback, config, fallback.plans);
  }

  const placeholders = allowed.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT id, chain_id, credits, token_amount, token_contract, token_decimals, label, description, offer, active,
              token_symbol, rpc_url, recipient
       FROM credit_plans
       WHERE active = 1 AND chain_id IN (${placeholders})
       ORDER BY sort_order ASC, id ASC`,
    )
    .all(...allowed) as CreditPlanRow[];

  if (rows.length === 0) {
    return finalizeBundle(fallback, config, fallback.plans);
  }

  const plans: CreditPlan[] = rows.map((r) => {
    const p: CreditPlan = {
      id: r.id,
      credits: r.credits,
      token_amount: r.token_amount,
      token_contract: r.token_contract,
      token_decimals: r.token_decimals,
      chain_id: r.chain_id,
      label: r.label,
      description: r.description,
      offer: r.offer ?? undefined,
      active: r.active === 1,
    };
    if (r.token_symbol) p.token_symbol = r.token_symbol;
    if (r.rpc_url) p.rpc_url = r.rpc_url;
    if (r.recipient) p.recipient = r.recipient;
    return p;
  });

  return finalizeBundle(fallback, config, plans);
}
