import { Hono } from "hono";
import type { AppConfig } from "../config.js";
import type { SqliteDb } from "../types.js";
import {
  generateUserCode,
  randomSessionToken,
  randomUuid,
  sha256Hex,
} from "../lib/crypto.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { validateAgentName, validateEmail } from "../lib/validate.js";

const initiatePerEmail = createRateLimiter(3_600_000, 5);
/** Web + CLI poll ~every 2s while pending; allow a small burst so we do not 429 legitimate polls. */
const statusPerToken = createRateLimiter(5_000, 3);

function nowIso(): string {
  return new Date().toISOString();
}

function expiresAtIso(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export function createSignupRoutes(db: SqliteDb, config: AppConfig) {
  const r = new Hono();

  r.post("/signup/initiate", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_json" }, 400);
    }
    const email = String((body as { email?: string }).email ?? "");
    const agentName = String((body as { agent_name?: string }).agent_name ?? "");

    const eErr = validateEmail(email);
    const aErr = validateAgentName(agentName);
    if (eErr || aErr) {
      return c.json({ error: "validation_failed", fields: { email: eErr, agent_name: aErr } }, 400);
    }

    const emailNorm = email.trim();

    const existingAccount = db
      .prepare(
        `SELECT 1 FROM api_keys WHERE lower(email) = lower(?) AND revoked_at IS NULL LIMIT 1`,
      )
      .get(emailNorm);
    if (existingAccount !== undefined) {
      return c.json(
        {
          error: "email_already_registered",
          message:
            "An account with this email already exists. Use your existing API key, or contact support to recover access.",
        },
        409,
      );
    }

    const rl = initiatePerEmail(emailNorm.toLowerCase());
    if (!rl.ok) {
      return c.json({ error: "rate_limited" }, 429, {
        "Retry-After": String(rl.retryAfterSec),
      });
    }

    const now = nowIso();
    const existing = db
      .prepare(
        `SELECT id, session_token_raw, user_code, expires_at FROM signup_sessions
         WHERE lower(email) = lower(?) AND status = 'pending' AND expires_at > ?`,
      )
      .get(emailNorm, now) as
      | {
          id: string;
          session_token_raw: string;
          user_code: string;
          expires_at: string;
        }
      | undefined;

    if (existing) {
      const exp = new Date(existing.expires_at).getTime();
      const expiresIn = Math.max(0, Math.floor((exp - Date.now()) / 1000));
      return c.json(
        {
          session_token: existing.session_token_raw,
          verification_url: `${config.baseUrl}/verify`,
          user_code: existing.user_code,
          expires_in: expiresIn,
        },
        200,
      );
    }

    let userCode = generateUserCode();
    for (let attempt = 0; attempt < 20; attempt++) {
      const clash = db
        .prepare(
          `SELECT 1 FROM signup_sessions WHERE user_code = ? AND expires_at > ?`,
        )
        .get(userCode, now);
      if (!clash) break;
      userCode = generateUserCode();
    }

    const rawToken = randomSessionToken();
    const tokenHash = sha256Hex(rawToken);
    const id = randomUuid();
    const expiresAt = expiresAtIso(config.sessionTtlSeconds);

    db.prepare(
      `INSERT INTO signup_sessions (
        id, email, agent_name, session_token_hash, session_token_raw, user_code,
        status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(id, emailNorm, agentName.trim(), tokenHash, rawToken, userCode, now, expiresAt);

    return c.json(
      {
        session_token: rawToken,
        verification_url: `${config.baseUrl}/verify`,
        user_code: userCode,
        expires_in: config.sessionTtlSeconds,
      },
      201,
    );
  });

  r.get("/signup/status", async (c) => {
    const token = c.req.query("session_token");
    if (!token?.trim()) {
      return c.json({ error: "session_token required" }, 400);
    }
    const hash = sha256Hex(token.trim());

    const poll = statusPerToken(hash);
    if (!poll.ok) {
      return c.json({ error: "rate_limited" }, 429, {
        "Retry-After": String(Math.max(1, poll.retryAfterSec)),
      });
    }

    const now = nowIso();
    const row = db
      .prepare(`SELECT * FROM signup_sessions WHERE session_token_hash = ?`)
      .get(hash) as Record<string, unknown> | undefined;

    if (!row) {
      return c.json({ error: "not_found" }, 404);
    }

    const status = String(row.status);
    const expiresAt = String(row.expires_at);
    const id = String(row.id);
    const delivered = Number(row.credentials_delivered) === 1;

    if (status === "pending" && new Date(expiresAt) <= new Date(now)) {
      db.prepare(`UPDATE signup_sessions SET status = 'expired' WHERE id = ?`).run(id);
      return c.json({ status: "expired" });
    }

    if (status === "pending") {
      const exp = new Date(expiresAt).getTime();
      const expiresIn = Math.max(0, Math.floor((exp - Date.now()) / 1000));
      return c.json({ status: "pending", expires_in: expiresIn });
    }

    if (status === "expired") {
      return c.json({ status: "expired" });
    }

    if (status === "approved") {
      if (delivered) {
        return c.json({ error: "not_found" }, 404);
      }
      const keyRow = db
        .prepare(`SELECT * FROM api_keys WHERE session_id = ?`)
        .get(id) as { api_key_raw: string | null; org_id: string; rate_limit_rpm: number; rate_limit_rpd: number } | undefined;

      if (!keyRow?.api_key_raw) {
        return c.json({ error: "not_found" }, 404);
      }

      db.prepare(
        `UPDATE signup_sessions SET credentials_delivered = 1, session_token_raw = '' WHERE id = ?`,
      ).run(id);
      db.prepare(`UPDATE api_keys SET api_key_raw = NULL WHERE session_id = ?`).run(id);

      return c.json({
        status: "approved",
        api_key: keyRow.api_key_raw,
        org_id: keyRow.org_id,
        rate_limits: {
          requests_per_minute: keyRow.rate_limit_rpm,
          requests_per_day: keyRow.rate_limit_rpd,
        },
      });
    }

    return c.json({ error: "not_found" }, 404);
  });

  return r;
}
