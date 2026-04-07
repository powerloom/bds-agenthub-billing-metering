function envNumber(name: string, defaultVal: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") {
    return defaultVal;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : defaultVal;
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
      "[bds-agent-signup] NODE_ENV=production requires TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY. " +
        "Or set SKIP_TURNSTILE=1 only for emergencies.",
    );
  }

  if (!hasTurnstileKeys && !isProd && !skipExplicit) {
    console.warn(
      "[bds-agent-signup] TURNSTILE_* unset — captcha skipped (local dev). Set keys to test Turnstile.",
    );
  }

  const skipTurnstile = skipExplicit || !hasTurnstileKeys;

  return {
    port: Number.isFinite(port) ? port : 8787,
    baseUrl,
    sessionTtlSeconds: Math.max(60, Number(process.env.SESSION_TTL_SECONDS ?? "600")),
    freeTierCredits: Math.max(0, Number(process.env.FREE_TIER_CREDITS ?? "10")),
    turnstileSiteKey,
    turnstileSecretKey,
    skipTurnstile,
    billingTopupUrl: (process.env.BILLING_TOPUP_URL ?? "https://powerloom.io").replace(/\/$/, ""),
    devTopupSecret: process.env.DEV_TOPUP_SECRET ?? "",
    internalBillingSecret: process.env.INTERNAL_BILLING_SECRET ?? "",
    creditPerEpoch: Math.max(1e-12, envNumber("CREDIT_PER_EPOCH", 10 / 7200)),
    creditPerStreamSession: Math.max(1e-12, envNumber("CREDIT_PER_STREAM_SESSION", 0.01)),
  };
}
