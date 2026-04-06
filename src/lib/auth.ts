import type { Context } from "hono";
import type { SqliteDb } from "../types.js";
import { sha256Hex } from "./crypto.js";

export type ApiKeyRecord = {
  id: string;
  email: string;
  org_id: string;
  credit_balance: number;
  total_credits_purchased: number;
  total_credits_used: number;
  rate_limit_rpm: number;
  rate_limit_rpd: number;
};

export function extractApiKey(c: Context): string | null {
  const auth = c.req.header("Authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const t = auth.slice(7).trim();
    if (t) return t;
  }
  const x = c.req.header("X-API-Key");
  return x?.trim() || null;
}

export function lookupApiKey(db: SqliteDb, rawKey: string): ApiKeyRecord | null {
  if (!rawKey.startsWith("sk_live_")) {
    return null;
  }
  const hash = sha256Hex(rawKey);
  const row = db
    .prepare(
      `SELECT id, email, org_id, credit_balance, total_credits_purchased,
              total_credits_used, rate_limit_rpm, rate_limit_rpd
       FROM api_keys
       WHERE api_key_hash = ? AND revoked_at IS NULL`,
    )
    .get(hash) as ApiKeyRecord | undefined;
  return row ?? null;
}
