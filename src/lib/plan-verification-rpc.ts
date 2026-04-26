import type { AppConfig } from "../config.js";
import { getPaymentChainById } from "../config.js";
import type { SqliteDb } from "../types.js";

/**
 * On-chain payment verification: private `credit_plans` row override, then
 * `PAYMENT_CHAINS` (never the sanitized `GET /credits/plans` bundle).
 */
export function getVerificationRpcForPlan(
  db: SqliteDb,
  config: AppConfig,
  planId: string,
  chainId: number,
): { rpcUrl: string; recipient: string } | null {
  const pay = getPaymentChainById(config, chainId);
  if (!pay) {
    return null;
  }
  if (config.creditPlansSource === "env") {
    return { rpcUrl: pay.rpc_url, recipient: pay.recipient };
  }
  const row = db
    .prepare(
      `SELECT rpc_url, recipient FROM credit_plans WHERE id = ? AND chain_id = ? AND active = 1`,
    )
    .get(planId, chainId) as { rpc_url: string | null; recipient: string | null } | undefined;
  if (!row) {
    return { rpcUrl: pay.rpc_url, recipient: pay.recipient };
  }
  const rpcUrl = (row.rpc_url && String(row.rpc_url).trim()) || pay.rpc_url;
  const recipient = (row.recipient && String(row.recipient).trim()) || pay.recipient;
  return { rpcUrl, recipient };
}
