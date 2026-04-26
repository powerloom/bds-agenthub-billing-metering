import type { PaymentChainConfig } from "../config.js";

/**
 * Remove userinfo and query from a URL string (safe to show if the path is already public).
 */
export function stripUrlCredentialsForDisplay(url: string): string {
  const u = String(url).trim();
  if (!u) {
    return u;
  }
  try {
    const parsed = new URL(u);
    parsed.search = "";
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return u;
  }
}

/**
 * Value for GET /credits/plans and pay-signup `rpc_hint`: only the optional **public** RPC
 * for this chain (never `rpc_url` used for server-side verification).
 */
export function publicRpcForPaymentChain(chain: PaymentChainConfig): string {
  const raw = (chain.public_rpc_url ?? "").trim();
  if (!raw) {
    return "";
  }
  return stripUrlCredentialsForDisplay(raw);
}
