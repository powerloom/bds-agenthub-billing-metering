function envNumber(name: string, defaultVal: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") {
    return defaultVal;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : defaultVal;
}

/** Single credit plan (GET /credits/plans + Tempo top-up verification). */
export type CreditPlan = {
  id: string;
  credits: number;
  tempo_amount: string;
  tempo_currency: string;
  /** TIP-20 / pathUSD-style decimals (default 6 on Tempo testnets). */
  tempo_decimals: number;
  /**
   * EVM chain id for this plan (e.g. 42431 Tempo Moderato, 4217 Tempo mainnet, 42161 Arbitrum One).
   * Must match deployment `TEMPO_CHAIN_ID` for the plan to be offered. Do not infer “mainnet” vs “testnet” from a single id — use chain registries (EIP-155) per ecosystem.
   */
  tempo_chain_id: number;
  label: string;
  description: string;
  offer?: string;
  active: boolean;
};

/** Full JSON returned by GET /credits/plans. */
export type CreditPlansBundle = {
  plans: CreditPlan[];
  tempo_recipient: string;
  tempo_chain_id: number;
  tempo_rpc_url: string;
  epoch_unit: {
    credits_per_epoch: number;
    epochs_per_credit: number;
    note: string;
  };
};

const DEFAULT_TEMPO_CHAIN_ID = 42431;
const DEFAULT_TEMPO_RPC = "https://rpc.moderato.tempo.xyz";
const PATH_USD_MODERATO = "0x20c0000000000000000000000000000000000000";

function defaultPlansBundle(tempoRecipient: string, chainId: number, rpcUrl: string): CreditPlansBundle {
  return {
    plans: [
      {
        id: "launch_10",
        credits: 10,
        tempo_amount: "0.05",
        tempo_currency: PATH_USD_MODERATO,
        tempo_decimals: 6,
        tempo_chain_id: chainId,
        label: "10 credits — 1 full day (7200 epochs)",
        description:
          "Each credit = 720 epochs. allTrades, per-block aggregated snapshot. Ethereum mainnet ~12s block time.",
        offer: "launch_50pct_off",
        active: true,
      },
    ],
    tempo_recipient: tempoRecipient,
    tempo_chain_id: chainId,
    tempo_rpc_url: rpcUrl,
    epoch_unit: {
      credits_per_epoch: 10 / 7200,
      epochs_per_credit: 720,
      note: "1 credit = 720 epochs.",
    },
  };
}

function parseCreditPlansBundleFromEnv(): CreditPlansBundle {
  const raw = process.env.CREDIT_PLANS_JSON?.trim();
  const tempoRecipient = (process.env.MPP_TEMPO_RECIPIENT ?? "").trim();
  const chainId = Math.round(envNumber("TEMPO_CHAIN_ID", DEFAULT_TEMPO_CHAIN_ID));
  const rpcFromEnv = (process.env.TEMPO_RPC_URL ?? process.env.MPP_TEMPO_RPC_URL ?? "").trim();
  const rpcUrl = rpcFromEnv || DEFAULT_TEMPO_RPC;

  if (!raw) {
    return defaultPlansBundle(tempoRecipient, chainId, rpcUrl);
  }
  try {
    const j = JSON.parse(raw) as Partial<CreditPlansBundle> & { plans?: CreditPlan[] };
    const base = defaultPlansBundle(tempoRecipient, chainId, rpcUrl);
    if (typeof j.tempo_recipient === "string" && j.tempo_recipient.trim()) {
      base.tempo_recipient = j.tempo_recipient.trim();
    }
    if (typeof j.tempo_chain_id === "number" && Number.isFinite(j.tempo_chain_id)) {
      base.tempo_chain_id = Math.round(j.tempo_chain_id);
    }
    if (typeof j.tempo_rpc_url === "string" && j.tempo_rpc_url.trim()) {
      base.tempo_rpc_url = j.tempo_rpc_url.trim();
    }
    if (j.epoch_unit && typeof j.epoch_unit === "object") {
      base.epoch_unit = { ...base.epoch_unit, ...j.epoch_unit };
    }
    if (Array.isArray(j.plans) && j.plans.length > 0) {
      base.plans = j.plans.map((p) => {
        const x = p as Partial<CreditPlan>;
        const planChain =
          typeof x.tempo_chain_id === "number" && Number.isFinite(x.tempo_chain_id)
            ? Math.round(x.tempo_chain_id)
            : base.tempo_chain_id;
        return {
          id: String(x.id ?? ""),
          credits: Number(x.credits ?? 0),
          tempo_amount: String(x.tempo_amount ?? "0"),
          tempo_currency: String(x.tempo_currency ?? ""),
          tempo_decimals: x.tempo_decimals ?? 6,
          tempo_chain_id: planChain,
          label: String(x.label ?? ""),
          description: String(x.description ?? ""),
          active: x.active !== false,
        } as CreditPlan;
      });
    }
    return base;
  } catch {
    throw new Error("[bds-agenthub-billing-metering] CREDIT_PLANS_JSON must be valid JSON.");
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
  /** Max Tempo top-up attempts per API key per rolling minute (spam guard). */
  creditTopupRatePerMinute: number;
};

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

  const creditPlansFallback = parseCreditPlansBundleFromEnv();
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
  };
}
