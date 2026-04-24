import fs from "node:fs";
import path from "node:path";

function envNumber(name: string, defaultVal: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") {
    return defaultVal;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : defaultVal;
}

/** Per-chain RPC + treasury; `rpc_url` in API responses is redacted when keys are in the path. */
export type PlanChainMeta = {
  chain_id: number;
  rpc_url: string;
  recipient: string;
};

export type PaymentChainConfig = {
  chain_id: number;
  /** Full URL including API key when applicable (server-only; not exposed in redacted form). */
  rpc_url: string;
  recipient: string;
};

/** Single credit plan (GET /credits/plans + ERC-20 top-up). DB columns match this shape (`chain_id`, `token_*`). */
export type CreditPlan = {
  id: string;
  credits: number;
  /** Human-readable token amount for this plan (same units as `token_decimals`). */
  token_amount: string;
  /** ERC-20 contract address (checksummed or lower). */
  token_contract: string;
  /** Token decimals (6 for USDC, 18 for many assets, etc.). */
  token_decimals: number;
  /** EIP-155 chain id for this row. */
  chain_id: number;
  /**
   * Display / agent UX (e.g. USDC, pathUSD, POWER). Same `token_symbol` can name different
   * assets: e.g. POWER on Ethereum L1 is an ERC-20; on `7869` (Powerloom Nitro) POWER is
   * the chain CGT (custom gas token), so `token_contract` / decimals differ by `chain_id`.
   */
  token_symbol?: string;
  /** Optional per-row override; otherwise `chains[].rpc_url` for this `chain_id` applies. */
  rpc_url?: string;
  /** Optional per-row override; otherwise `chains[].recipient` for this `chain_id` applies. */
  recipient?: string;
  label: string;
  description: string;
  offer?: string;
  active: boolean;
};

/** Resolved plans bundle returned by GET /credits/plans. */
export type CreditPlansBundle = {
  plans: CreditPlan[];
  /** All chains this deployment can verify `POST /credits/topup` on. */
  chains: PlanChainMeta[];
  terms_url: string;
  terms_version: string;
  /** Default / primary chain for older clients (`PAYMENT_CHAINS_PRIMARY_ID`, else `TEMPO_CHAIN_ID`). */
  primary_recipient: string;
  primary_chain_id: number;
  primary_rpc_url: string;
  epoch_unit: {
    credits_per_epoch: number;
    epochs_per_credit: number;
    note: string;
  };
};

const DEFAULT_TEMPO_CHAIN_ID = 42431;
const DEFAULT_TEMPO_RPC = "https://rpc.moderato.tempo.xyz";
const DEFAULT_TERMS_VERSION = "v1";

/**
 * Per-chain payment config:
 * - If **`PAYMENT_CHAINS_JSON_FILE`** is set: read that path (UTF-8 JSON array). Relative paths are relative to `process.cwd()`.
 * - Else if **`PAYMENT_CHAINS_JSON`** is set: use its string value (inline JSON, e.g. in `.env` or process env).
 * - Else: single entry from `TEMPO_*` + `MPP_TEMPO_RECIPIENT`.
 */
function loadPaymentChainsJsonRawForParse():
  | { raw: string; configLabel: string }
  | undefined {
  const filePath = process.env.PAYMENT_CHAINS_JSON_FILE?.trim();
  if (filePath) {
    const resolved = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    let text: string;
    try {
      text = fs.readFileSync(resolved, "utf-8");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `[bds-agenthub-billing-metering] PAYMENT_CHAINS_JSON_FILE: cannot read ${resolved}: ${msg}`,
      );
    }
    const raw = text.trim();
    if (!raw) {
      throw new Error(
        `[bds-agenthub-billing-metering] PAYMENT_CHAINS_JSON_FILE: file is empty (${resolved}).`,
      );
    }
    return { raw, configLabel: "PAYMENT_CHAINS_JSON_FILE" };
  }
  const inline = process.env.PAYMENT_CHAINS_JSON?.trim();
  if (inline) {
    return { raw: inline, configLabel: "PAYMENT_CHAINS_JSON" };
  }
  return undefined;
}

export function parsePaymentChainsFromEnv(): PaymentChainConfig[] {
  const loaded = loadPaymentChainsJsonRawForParse();
  if (!loaded) {
    const chainId = Math.round(envNumber("TEMPO_CHAIN_ID", DEFAULT_TEMPO_CHAIN_ID));
    const rpcFromEnv = (process.env.TEMPO_RPC_URL ?? process.env.MPP_TEMPO_RPC_URL ?? "").trim();
    const rpcUrl = rpcFromEnv || DEFAULT_TEMPO_RPC;
    const recipient = (process.env.MPP_TEMPO_RECIPIENT ?? "").trim();
    return [{ chain_id: chainId, rpc_url: rpcUrl, recipient }];
  }
  const { raw, configLabel } = loaded;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `[bds-agenthub-billing-metering] ${configLabel} must contain valid JSON (non-empty array of chain objects).`,
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      `[bds-agenthub-billing-metering] ${configLabel} must be a non-empty JSON array of chain objects.`,
    );
  }
  const out: PaymentChainConfig[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < parsed.length; i += 1) {
    const x = parsed[i];
    if (x === null || typeof x !== "object") {
      throw new Error(`[bds-agenthub-billing-metering] ${configLabel} index ${i} must be an object.`);
    }
    const o = x as Record<string, unknown>;
    const chainId = Math.round(Number(o.chain_id));
    const rpcUrl = String(o.rpc_url ?? "").trim();
    const recipient = String(o.recipient ?? "").trim();
    if (!Number.isFinite(chainId) || chainId < 0) {
      throw new Error(
        `[bds-agenthub-billing-metering] ${configLabel}[${i}].chain_id must be a non-negative number.`,
      );
    }
    if (!rpcUrl) {
      throw new Error(`[bds-agenthub-billing-metering] ${configLabel}[${i}].rpc_url is required.`);
    }
    if (!recipient) {
      throw new Error(`[bds-agenthub-billing-metering] ${configLabel}[${i}].recipient is required.`);
    }
    if (seen.has(chainId)) {
      throw new Error(
        `[bds-agenthub-billing-metering] ${configLabel}: duplicate chain_id ${chainId}.`,
      );
    }
    seen.add(chainId);
    out.push({ chain_id: chainId, rpc_url: rpcUrl, recipient });
  }
  return out;
}

function defaultPlansBundle(
  tempoRecipient: string,
  chainId: number,
  rpcUrl: string,
  termsVersion: string,
): CreditPlansBundle {
  return {
    plans: [],
    chains: [],
    terms_url: "",
    terms_version: termsVersion,
    primary_recipient: tempoRecipient,
    primary_chain_id: chainId,
    primary_rpc_url: rpcUrl,
    epoch_unit: {
      credits_per_epoch: 10 / 7200,
      epochs_per_credit: 720,
      note: "1 credit = 720 epochs.",
    },
  };
}

/** Map one plan object from `CREDIT_PLANS_JSON` (canonical keys only). */
function creditPlanFromEnvJson(x: unknown, defaultChainId: number): CreditPlan {
  const r = x as Record<string, unknown>;
  const chainFrom =
    typeof r.chain_id === "number" && Number.isFinite(r.chain_id) ? Math.round(r.chain_id) : defaultChainId;
  const tokenAmount = typeof r.token_amount === "string" && r.token_amount !== "" ? r.token_amount : "0";
  const tokenContract = typeof r.token_contract === "string" ? r.token_contract : "";
  const tokenDecimals =
    typeof r.token_decimals === "number" && Number.isFinite(r.token_decimals) ? Math.round(r.token_decimals) : 6;
  const plan: CreditPlan = {
    id: String(r.id ?? ""),
    credits: Number(r.credits ?? 0),
    token_amount: String(tokenAmount),
    token_contract: String(tokenContract),
    token_decimals: tokenDecimals,
    chain_id: chainFrom,
    label: String(r.label ?? ""),
    description: String(r.description ?? ""),
    active: r.active !== false,
  };
  if (typeof r.token_symbol === "string" && r.token_symbol.trim()) {
    plan.token_symbol = r.token_symbol.trim();
  }
  if (typeof r.rpc_url === "string" && r.rpc_url.trim()) {
    plan.rpc_url = r.rpc_url.trim();
  }
  if (typeof r.recipient === "string" && r.recipient.trim()) {
    plan.recipient = r.recipient.trim();
  }
  if (r.offer != null && String(r.offer).trim() !== "") {
    plan.offer = String(r.offer);
  }
  return plan;
}

function parseCreditPlansBundleFromEnv(termsVersion: string): CreditPlansBundle {
  const raw = process.env.CREDIT_PLANS_JSON?.trim();
  const tempoRecipient = (process.env.MPP_TEMPO_RECIPIENT ?? "").trim();
  const chainId = Math.round(envNumber("TEMPO_CHAIN_ID", DEFAULT_TEMPO_CHAIN_ID));
  const rpcFromEnv = (process.env.TEMPO_RPC_URL ?? process.env.MPP_TEMPO_RPC_URL ?? "").trim();
  const rpcUrl = rpcFromEnv || DEFAULT_TEMPO_RPC;

  if (!raw) {
    return defaultPlansBundle(tempoRecipient, chainId, rpcUrl, termsVersion);
  }
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const base = defaultPlansBundle(tempoRecipient, chainId, rpcUrl, termsVersion);
    if (typeof j.primary_recipient === "string" && j.primary_recipient.trim()) {
      base.primary_recipient = j.primary_recipient.trim();
    }
    if (typeof j.primary_chain_id === "number" && Number.isFinite(j.primary_chain_id)) {
      base.primary_chain_id = Math.round(j.primary_chain_id);
    }
    if (typeof j.primary_rpc_url === "string" && j.primary_rpc_url.trim()) {
      base.primary_rpc_url = j.primary_rpc_url.trim();
    }
    if (j.epoch_unit && typeof j.epoch_unit === "object") {
      base.epoch_unit = { ...base.epoch_unit, ...j.epoch_unit } as CreditPlansBundle["epoch_unit"];
    }
    if (Array.isArray(j.plans) && j.plans.length > 0) {
      base.plans = j.plans.map((p) => creditPlanFromEnvJson(p, base.primary_chain_id));
    }
    return base;
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error("[bds-agenthub-billing-metering] CREDIT_PLANS_JSON must be valid JSON.");
    }
    throw e;
  }
}

export type AppConfig = {
  port: number;
  baseUrl: string;
  sessionTtlSeconds: number;
  freeTierCredits: number;
  turnstileSiteKey: string;
  turnstileSecretKey: string;
  skipTurnstile: boolean;
  /** Shown in API/CLI when self-serve checkout is not wired yet */
  billingTopupUrl: string;
  /** If set, POST /credits/topup with X-BDS-Dev-Topup-Secret can add credits (local/staging only) */
  devTopupSecret: string;
  /** Shared with BDS Core API for POST /internal/billing/deduct */
  internalBillingSecret: string;
  /** One GET /mpp/snapshot/... per epoch (10 credits ≈ 7200 epochs on mainnet) */
  creditPerEpoch: number;
  /** Flat credits for one SSE connection (e.g. /mpp/stream/allTrades) */
  creditPerStreamSession: number;
  /**
   * Fallback when `credit_plans` is empty or `CREDIT_PLANS_SOURCE=env`.
   * Built from CREDIT_PLANS_JSON (optional) + MPP_TEMPO_RECIPIENT + TEMPO_* env.
   */
  creditPlansFallback: CreditPlansBundle;
  /** `db` = use SQLite `credit_plans` when non-empty; `env` = always use fallback only. */
  creditPlansSource: "db" | "env";
  /** Max on-chain top-up attempts per API key per rolling minute (spam guard). */
  creditTopupRatePerMinute: number;
  /** Unredacted: server-side verification and `getPaymentChainById`. */
  paymentChains: PaymentChainConfig[];
  /** Which `chain_id` is primary for `GET /credits/plans` legacy + canonical top-level fields. Defaults to `TEMPO_CHAIN_ID`. */
  paymentChainsPrimaryId: number;
  termsUrl: string;
  termsVersion: string;
  /** Pay-signup quote lifetime (device-auth is unchanged). */
  signupPayQuoteTtlSec: number;
};

export function getPrimaryPaymentChain(config: AppConfig): PaymentChainConfig {
  const p = config.paymentChains.find((c) => c.chain_id === config.paymentChainsPrimaryId);
  if (p) {
    return p;
  }
  if (config.paymentChains.length > 0) {
    return config.paymentChains[0]!;
  }
  throw new Error("[bds-agenthub-billing-metering] internal: paymentChains is empty");
}

export function getPaymentChainById(config: AppConfig, chainId: number): PaymentChainConfig | undefined {
  return config.paymentChains.find((c) => c.chain_id === chainId);
}

export function loadConfig(): AppConfig {
  const port = Number(process.env.PORT ?? "8787");
  const baseUrl = (process.env.BASE_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, "");
  const turnstileSiteKey = process.env.TURNSTILE_SITE_KEY ?? "";
  const turnstileSecretKey = process.env.TURNSTILE_SECRET_KEY ?? "";
  const skipExplicit =
    process.env.SKIP_TURNSTILE === "1" || process.env.SKIP_TURNSTILE === "true";
  const hasTurnstileKeys = Boolean(turnstileSiteKey && turnstileSecretKey);
  const isProd = process.env.NODE_ENV === "production";

  if (isProd && !hasTurnstileKeys && !skipExplicit) {
    throw new Error(
      "[bds-agenthub-billing-metering] NODE_ENV=production requires TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY. " +
        "Or set SKIP_TURNSTILE=1 only for emergencies.",
    );
  }

  if (!hasTurnstileKeys && !isProd && !skipExplicit) {
    console.warn(
      "[bds-agenthub-billing-metering] TURNSTILE_* unset — captcha skipped (local dev). Set keys to test Turnstile.",
    );
  }

  const skipTurnstile = skipExplicit || !hasTurnstileKeys;

  const termsVersion = (process.env.TERMS_VERSION ?? DEFAULT_TERMS_VERSION).trim() || DEFAULT_TERMS_VERSION;
  const termsUrl = `${baseUrl}/agents-tos/${termsVersion}`;

  const defaultChain = Math.round(envNumber("TEMPO_CHAIN_ID", DEFAULT_TEMPO_CHAIN_ID));
  const primaryRaw = process.env.PAYMENT_CHAINS_PRIMARY_ID?.trim();
  const paymentChainsPrimaryId = primaryRaw
    ? Math.round(Number(primaryRaw))
    : defaultChain;
  if (!Number.isFinite(paymentChainsPrimaryId) || paymentChainsPrimaryId < 0) {
    throw new Error("[bds-agenthub-billing-metering] PAYMENT_CHAINS_PRIMARY_ID must be a non-negative number.");
  }

  const paymentChains = parsePaymentChainsFromEnv();
  const creditPlansFallback: CreditPlansBundle = {
    ...parseCreditPlansBundleFromEnv(termsVersion),
    terms_url: termsUrl,
    terms_version: termsVersion,
  };
  const cps = (process.env.CREDIT_PLANS_SOURCE ?? "db").trim().toLowerCase();
  const creditPlansSource: "db" | "env" = cps === "env" ? "env" : "db";

  return {
    port: Number.isFinite(port) ? port : 8787,
    baseUrl,
    sessionTtlSeconds: Math.max(60, Number(process.env.SESSION_TTL_SECONDS ?? "600")),
    /** Signup bonus (verify route). Override with FREE_TIER_CREDITS. */
    freeTierCredits: Math.max(0, Number(process.env.FREE_TIER_CREDITS ?? "2")),
    turnstileSiteKey,
    turnstileSecretKey,
    skipTurnstile,
    billingTopupUrl: (process.env.BILLING_TOPUP_URL ?? "https://powerloom.io").replace(/\/$/, ""),
    devTopupSecret: process.env.DEV_TOPUP_SECRET ?? "",
    internalBillingSecret: process.env.INTERNAL_BILLING_SECRET ?? "",
    creditPerEpoch: Math.max(1e-12, envNumber("CREDIT_PER_EPOCH", 10 / 7200)),
    creditPerStreamSession: Math.max(1e-12, envNumber("CREDIT_PER_STREAM_SESSION", 0.01)),
    creditPlansFallback,
    creditPlansSource,
    creditTopupRatePerMinute: Math.max(1, Math.min(120, Math.round(envNumber("CREDIT_TOPUP_RATE_PER_MINUTE", 10)))),
    paymentChains,
    paymentChainsPrimaryId,
    termsUrl,
    termsVersion,
    signupPayQuoteTtlSec: Math.max(60, Math.round(envNumber("SIGNUP_PAY_QUOTE_TTL_SEC", 1800))),
  };
}
