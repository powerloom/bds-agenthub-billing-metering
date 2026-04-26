import type { AppConfig, CreditPlan, CreditPlanPaymentKind, CreditPlansBundle } from "../config.js";
import { getPaymentChainById, getPrimaryPaymentChain } from "../config.js";
import { publicRpcForPaymentChain } from "./public-rpc.js";
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
  payment_kind: string | null;
};

function toPublicChains(config: AppConfig): CreditPlansBundle["chains"] {
  return config.paymentChains.map((c) => ({
    chain_id: c.chain_id,
    rpc_url: publicRpcForPaymentChain(c),
    recipient: c.recipient,
  }));
}

function primaryBundleFields(config: AppConfig): Pick<CreditPlansBundle, "primary_recipient" | "primary_chain_id" | "primary_rpc_url"> {
  const primary = getPrimaryPaymentChain(config);
  return {
    primary_recipient: primary.recipient,
    primary_chain_id: primary.chain_id,
    primary_rpc_url: publicRpcForPaymentChain(primary),
  };
}

/**
 * `plans[].rpc_url` in the public bundle must not echo `credit_plans.rpc_url` (private
 * verification node). Use the same public hint as `chains[]` for that `chain_id`.
 */
function publicPlanRpcsForApi(plans: CreditPlan[], config: AppConfig): CreditPlan[] {
  return plans.map((p) => {
    const ch = getPaymentChainById(config, p.chain_id);
    const pub = ch ? publicRpcForPaymentChain(ch) : "";
    if (pub) {
      return { ...p, rpc_url: pub };
    }
    const { rpc_url: _drop, ...rest } = p;
    return { ...rest };
  });
}

/**
 * Merges plans with `config` metadata for GET /credits/plans.
 */
function finalizeBundle(base: CreditPlansBundle, config: AppConfig, plans: CreditPlan[]): CreditPlansBundle {
  return {
    ...base,
    plans: publicPlanRpcsForApi(plans, config),
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
 *   (`PAYMENT_CHAINS_PRIMARY_ID`, default `TEMPO_CHAIN_ID`). `primary_rpc_url` is the optional
 *   `public_rpc_url` for that chain only, never the private `rpc_url`.
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
              token_symbol, rpc_url, recipient, payment_kind
       FROM credit_plans
       WHERE active = 1 AND chain_id IN (${placeholders})
       ORDER BY sort_order ASC, id ASC`,
    )
    .all(...allowed) as CreditPlanRow[];

  if (rows.length === 0) {
    return finalizeBundle(fallback, config, fallback.plans);
  }

  const plans: CreditPlan[] = rows.map((r) => {
    const pk: CreditPlanPaymentKind = r.payment_kind === "native_value" ? "native_value" : "erc20";
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
      payment_kind: pk,
    };
    if (r.token_symbol) p.token_symbol = r.token_symbol;
    if (r.recipient) p.recipient = r.recipient;
    return p;
  });

  return finalizeBundle(fallback, config, plans);
}
