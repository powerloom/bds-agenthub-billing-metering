import type { SqliteDb } from "../types.js";

/**
 * Default rows for `npm run seed:plans` (INSERT OR IGNORE by PK `(id, chain_id)` in API terms).
 *
 * The plan doc §2.4 uses one `plan_id` per chain with multiple tokens; the SQLite primary key
 * `(id, chain_id)` only allows one row per `id` per chain, so we use disambiguated `id` values
 * (e.g. `launch_10_eth_usdc` vs `launch_10_eth_usdt`) when two tokens share a chain.
 * RPC / treasury stay on **`PAYMENT_CHAINS_JSON(_FILE)`**; per-row `rpc_url` / `recipient` here
 * are optional overrides (usually NULL).
 *
 * **7869 (Powerloom mainnet):** POWER is the **CGT**; use `payment_kind: "native_value"` and
 * `token_contract` all-zero (placeholder). Verification uses `tx.value`, not ERC-20 logs.
 * Treasury / RPC for 7869 come from **`PAYMENT_CHAINS_JSON(_FILE)`** (not from this row’s
 * optional `rpc_url` / `recipient` unless you set overrides).
 */
export type CreditPlanSeed = {
  id: string;
  credits: number;
  /** Human-readable token amount (same units as `token_decimals`). */
  token_amount: string;
  /**
   * For `erc20`: real ERC-20. For `native_value`: use `0x0000…0000` (placeholder; min amount is
   * still `token_amount` + `token_decimals` vs `tx.value`).
   */
  token_contract: string;
  token_decimals: number;
  /** EIP-155 chain id. */
  chain_id: number;
  label: string;
  description: string;
  offer: string | null;
  sort_order: number;
  /** Display + pay-signup matching (GET /credits/plans, POST /signup/pay/quote). */
  token_symbol: string;
  rpc_url?: string | null;
  recipient?: string | null;
  /** Defaults to `erc20` when omitted. */
  payment_kind?: "erc20" | "native_value";
};

export const DEFAULT_CREDIT_PLAN_SEEDS: CreditPlanSeed[] = [
  {
    id: "launch_10_eth_power",
    credits: 10,
    token_amount: "500",
    token_contract: "0x429f0d8233e517f9acf6f0c8293bf35804063a83",
    token_decimals: 18,
    chain_id: 1,
    label: "10 credits — 10 full days (72000 epochs) — POWER ERC-20 (Ethereum L1)",
    description:
      "Each credit = 7200 epochs (~1 full day). allTrades, per-block aggregated snapshot.",
    offer: "launch_50pct_off",
    sort_order: 0,
    token_symbol: "POWER",
    payment_kind: "erc20",
  },
  {
    id: "launch_10_tempo_pathusd",
    credits: 10,
    token_amount: "50000",
    token_contract: "0x20c0000000000000000000000000000000000000",
    token_decimals: 6,
    chain_id: 42431,
    label: "10 credits — 10 full days (72000 epochs) — pathUSD (Moderato)",
    description: "Each credit = 7200 epochs (~1 full day). allTrades, per-block aggregated snapshot. Ethereum mainnet ~12s block time.",
    offer: "launch_50pct_off",
    sort_order: 1,
    token_symbol: "pathUSD",
    payment_kind: "erc20",
  },
  {
    id: "launch_10_eth_usdc",
    credits: 10,
    token_amount: "5",
    token_contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    token_decimals: 6,
    chain_id: 1,
    label: "10 credits — USDC on Ethereum",
    description: "10 credits, pay 5 USDC. Verify contract on Etherscan before mainnet use.",
    offer: "launch_50pct_off",
    sort_order: 2,
    token_symbol: "USDC",
    payment_kind: "erc20",
  },
  {
    id: "launch_10_eth_usdt",
    credits: 10,
    token_amount: "5",
    token_contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    token_decimals: 6,
    chain_id: 1,
    label: "10 credits — USDT on Ethereum",
    description: "10 credits, pay 5 USDT.",
    offer: "launch_50pct_off",
    sort_order: 3,
    token_symbol: "USDT",
    payment_kind: "erc20",
  },
  {
    id: "launch_10_pol_usdc",
    credits: 10,
    token_amount: "5",
    token_contract: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    token_decimals: 6,
    chain_id: 137,
    label: "10 credits — USDC on Polygon",
    description: "10 credits, pay 5 USDC (native USDC on Polygon PoS).",
    offer: "launch_50pct_off",
    sort_order: 4,
    token_symbol: "USDC",
    payment_kind: "erc20",
  },
  {
    id: "launch_10_pol_usdt",
    credits: 10,
    token_amount: "5",
    token_contract: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    token_decimals: 6,
    chain_id: 137,
    label: "10 credits — USDT on Polygon",
    description: "10 credits, pay 5 USDT on Polygon.",
    offer: "launch_50pct_off",
    sort_order: 5,
    token_symbol: "USDT",
    payment_kind: "erc20",
  },
  {
    id: "launch_10_arb_usdc",
    credits: 10,
    token_amount: "5",
    token_contract: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    token_decimals: 6,
    chain_id: 42161,
    label: "10 credits — USDC on Arbitrum One",
    description: "10 credits, pay 5 USDC on Arbitrum One.",
    offer: "launch_50pct_off",
    sort_order: 6,
    token_symbol: "USDC",
    payment_kind: "erc20",
  },
  {
    id: "launch_10_arb_usdt",
    credits: 10,
    token_amount: "5",
    token_contract: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    token_decimals: 6,
    chain_id: 42161,
    label: "10 credits — USDT on Arbitrum One",
    description: "10 credits, pay 5 USDT on Arbitrum One.",
    offer: "launch_50pct_off",
    sort_order: 7,
    token_symbol: "USDT",
    payment_kind: "erc20",
  },
  {
    id: "launch_10_op_usdc",
    credits: 10,
    token_amount: "5",
    token_contract: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    token_decimals: 6,
    chain_id: 10,
    label: "10 credits — USDC on Optimism",
    description: "10 credits, pay 5 USDC on Optimism.",
    offer: "launch_50pct_off",
    sort_order: 8,
    token_symbol: "USDC",
    payment_kind: "erc20",
  },
  {
    id: "launch_10_op_usdt",
    credits: 10,
    token_amount: "5",
    token_contract: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
    token_decimals: 6,
    chain_id: 10,
    label: "10 credits — USDT on Optimism",
    description: "10 credits, pay 5 USDT on Optimism.",
    offer: "launch_50pct_off",
    sort_order: 9,
    token_symbol: "USDT",
    payment_kind: "erc20",
  },
  {
    id: "launch_10_pl_power_cgt",
    credits: 10,
    token_amount: "5",
    token_contract: "0x0000000000000000000000000000000000000000",
    token_decimals: 18,
    chain_id: 7869,
    label: "10 credits — POWER (native / CGT on Powerloom 7869)",
    description:
      "10 credits: send at least 5 POWER on chain 7869 as a plain value transfer to the configured recipient. Not Ethereum L1 ERC-20 POWER.",
    offer: "launch_50pct_off",
    sort_order: 10,
    token_symbol: "POWER",
    payment_kind: "native_value",
  },
];

/**
 * Inserts default plans where the `(id, chain_id)` pair is missing (`INSERT OR IGNORE`).
 */
export function seedDefaultCreditPlans(db: SqliteDb): number {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO credit_plans (
       id, chain_id, credits, token_amount, token_contract, token_decimals,
       label, description, offer, active, sort_order, created_at, updated_at,
       token_symbol, rpc_url, recipient, payment_kind
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  for (const p of DEFAULT_CREDIT_PLAN_SEEDS) {
    const kind = p.payment_kind === "native_value" ? "native_value" : "erc20";
    const info = stmt.run(
      p.id,
      p.chain_id,
      p.credits,
      p.token_amount,
      p.token_contract,
      p.token_decimals,
      p.label,
      p.description,
      p.offer,
      p.sort_order,
      now,
      now,
      p.token_symbol,
      p.rpc_url ?? null,
      p.recipient ?? null,
      kind,
    );
    inserted += Number(info.changes ?? 0);
  }

  return inserted;
}
