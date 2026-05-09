import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { getAddress, verifyMessage } from "viem";
import type { AppConfig } from "../config.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { randomUuid, randomApiKey, sha256Hex } from "../lib/crypto.js";
import type { SqliteDb } from "../types.js";

const EVM_ADDR = /^0x[a-fA-F0-9]{40}$/;

function nowIso(): string {
  return new Date().toISOString();
}

function expiresAtIso(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function normalizeEvmAddress(a: string): string {
  const x = a.trim().toLowerCase();
  if (!EVM_ADDR.test(x)) {
    throw new Error("invalid_address");
  }
  return x;
}

const challengePerIp = createRateLimiter(60_000, 20);
const challengePerAddress = createRateLimiter(600_000, 8);
const verifyPerIp = createRateLimiter(60_000, 40);

export function createApiKeyRecoverRoutes(db: SqliteDb, config: AppConfig) {
  const r = new Hono();

  r.post("/api-key/recover/challenge", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_json" }, 400);
    }
    const rawAddr = String((body as { address?: string }).address ?? "").trim();
    let addrLower: string;
    try {
      addrLower = normalizeEvmAddress(rawAddr);
    } catch {
      return c.json(
        { error: "validation_failed", message: "address must be a 0x-prefixed 40-hex EVM address." },
        400,
      );
    }

    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      c.req.header("x-real-ip") ??
      c.req.header("cf-connecting-ip") ??
      "unknown";
    const ipLim = challengePerIp(`recover-challenge-ip:${ip}`);
    if (!ipLim.ok) {
      return c.json(
        { error: "rate_limited", retry_after_sec: ipLim.retryAfterSec },
        429,
        { "Retry-After": String(Math.max(1, ipLim.retryAfterSec)) },
      );
    }
    const addrLim = challengePerAddress(`recover-challenge-addr:${addrLower}`);
    if (!addrLim.ok) {
      return c.json(
        { error: "rate_limited", retry_after_sec: addrLim.retryAfterSec },
        429,
        { "Retry-After": String(Math.max(1, addrLim.retryAfterSec)) },
      );
    }

    db.prepare(`DELETE FROM api_key_recovery_challenges WHERE expires_at <= ?`).run(nowIso());

    const keyRow = db
      .prepare(
        `SELECT id FROM api_keys
         WHERE lower(payer_address) = lower(?) AND revoked_at IS NULL LIMIT 1`,
      )
      .get(addrLower) as { id: string } | undefined;

    if (!keyRow) {
      return c.json(
        {
          error: "no_linked_wallet",
          message:
            "No active API key is linked to this wallet. Pay-signup accounts use payer_address; email signups use /signup and do not support wallet recovery here.",
        },
        404,
      );
    }

    const nonce = `rec_${randomBytes(16).toString("hex")}`;
    const expiresAt = expiresAtIso(config.apiKeyRecoveryChallengeTtlSec);
    const createdAt = nowIso();
    const message = [
      "BDS Agent Hub — API key rotation",
      "",
      "Sign to prove you control the wallet linked to your API key.",
      "A new API key will be issued; the previous key will stop working immediately.",
      "",
      `address: ${addrLower}`,
      `nonce: ${nonce}`,
      `expires_at: ${expiresAt}`,
      `terms: ${config.termsUrl}`,
    ].join("\n");

    const id = randomUuid();
    db.prepare(`DELETE FROM api_key_recovery_challenges WHERE address_lower = ?`).run(addrLower);
    db.prepare(
      `INSERT INTO api_key_recovery_challenges (id, address_lower, nonce, message, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, addrLower, nonce, message, expiresAt, createdAt);

    return c.json(
      {
        nonce,
        message,
        expires_at: expiresAt,
        expires_in: config.apiKeyRecoveryChallengeTtlSec,
      },
      201,
    );
  });

  r.post("/api-key/recover/verify", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_json" }, 400);
    }
    const o = body as { address?: string; signature?: string; nonce?: string };
    const rawAddr = String(o.address ?? "").trim();
    const signature = String(o.signature ?? "").trim();
    const nonce = String(o.nonce ?? "").trim();
    if (!nonce || !signature) {
      return c.json({ error: "validation_failed", message: "nonce and signature are required." }, 400);
    }
    let addrLower: string;
    try {
      addrLower = normalizeEvmAddress(rawAddr);
    } catch {
      return c.json(
        { error: "validation_failed", message: "address must be a 0x-prefixed 40-hex EVM address." },
        400,
      );
    }

    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      c.req.header("x-real-ip") ??
      c.req.header("cf-connecting-ip") ??
      "unknown";
    const vLim = verifyPerIp(`recover-verify-ip:${ip}`);
    if (!vLim.ok) {
      return c.json(
        { error: "rate_limited", retry_after_sec: vLim.retryAfterSec },
        429,
        { "Retry-After": String(Math.max(1, vLim.retryAfterSec)) },
      );
    }

    const ch = db
      .prepare(
        `SELECT id, address_lower, message, expires_at FROM api_key_recovery_challenges WHERE nonce = ?`,
      )
      .get(nonce) as
      | { id: string; address_lower: string; message: string; expires_at: string }
      | undefined;

    if (!ch) {
      return c.json({ error: "not_found", message: "Unknown or expired recovery nonce. Request a new challenge." }, 404);
    }
    if (ch.address_lower !== addrLower) {
      return c.json({ error: "address_mismatch", message: "address does not match this nonce." }, 400);
    }
    if (new Date(ch.expires_at).getTime() <= Date.now()) {
      db.prepare(`DELETE FROM api_key_recovery_challenges WHERE id = ?`).run(ch.id);
      return c.json({ error: "challenge_expired", message: "Challenge expired. Request a new challenge." }, 410);
    }

    let valid: boolean;
    try {
      valid = await verifyMessage({
        address: getAddress(addrLower),
        message: ch.message,
        signature: signature as `0x${string}`,
      });
    } catch {
      valid = false;
    }

    if (!valid) {
      return c.json({ error: "invalid_signature", message: "Signature verification failed." }, 400);
    }

    const keyRow = db
      .prepare(
        `SELECT id, org_id, rate_limit_rpm, rate_limit_rpd, credit_balance
         FROM api_keys
         WHERE lower(payer_address) = lower(?) AND revoked_at IS NULL LIMIT 1`,
      )
      .get(addrLower) as
      | {
          id: string;
          org_id: string;
          rate_limit_rpm: number;
          rate_limit_rpd: number;
          credit_balance: number;
        }
      | undefined;

    if (!keyRow) {
      db.prepare(`DELETE FROM api_key_recovery_challenges WHERE id = ?`).run(ch.id);
      return c.json(
        { error: "no_linked_wallet", message: "Account was removed or revoked. Request a new challenge." },
        409,
      );
    }

    const newRaw = randomApiKey();
    const newHash = sha256Hex(newRaw);

    db.transaction(() => {
      db.prepare(`UPDATE api_keys SET api_key_hash = ? WHERE id = ?`).run(newHash, keyRow.id);
      db.prepare(`DELETE FROM api_key_recovery_challenges WHERE id = ?`).run(ch.id);
    })();

    return c.json({
      status: "ok",
      rotated: true,
      api_key: newRaw,
      org_id: keyRow.org_id,
      credit_balance: keyRow.credit_balance,
      rate_limits: {
        requests_per_minute: keyRow.rate_limit_rpm,
        requests_per_day: keyRow.rate_limit_rpd,
      },
    });
  });

  return r;
}
