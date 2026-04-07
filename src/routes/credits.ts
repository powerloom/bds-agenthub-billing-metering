import { Hono } from "hono";
import type { AppConfig } from "../config.js";
import { extractApiKey, lookupApiKey } from "../lib/auth.js";
import { randomUuid } from "../lib/crypto.js";
import type { SqliteDb } from "../types.js";

export function createCreditsRoutes(db: SqliteDb, config: AppConfig) {
  const r = new Hono();

  r.get("/credits/balance", (c) => {
    const raw = extractApiKey(c);
    if (!raw) {
      return c.json({ error: "unauthorized", message: "Send Authorization: Bearer <api_key> or X-API-Key" }, 401);
    }
    const row = lookupApiKey(db, raw);
    if (!row) {
      return c.json({ error: "unauthorized", message: "Invalid or revoked API key" }, 401);
    }
    return c.json({
      org_id: row.org_id,
      email: row.email,
      credit_balance: row.credit_balance,
      total_credits_purchased: row.total_credits_purchased,
      total_credits_used: row.total_credits_used,
      rate_limits: {
        requests_per_minute: row.rate_limit_rpm,
        requests_per_day: row.rate_limit_rpd,
      },
    });
  });

  r.post("/credits/topup", async (c) => {
    const raw = extractApiKey(c);
    if (!raw) {
      return c.json({ error: "unauthorized", message: "Send Authorization: Bearer <api_key> or X-API-Key" }, 401);
    }
    const row = lookupApiKey(db, raw);
    if (!row) {
      return c.json({ error: "unauthorized", message: "Invalid or revoked API key" }, 401);
    }

    const devSecret = config.devTopupSecret;
    const headerSecret = c.req.header("X-BDS-Dev-Topup-Secret") ?? "";

    if (!devSecret || headerSecret !== devSecret) {
      return c.json(
        {
          error: "checkout_not_available",
          message: "Self-serve credit purchase is not available yet. Use the billing link below when it is live.",
          billing_url: config.billingTopupUrl,
        },
        501,
      );
    }

    const body = await c.req.json().catch(() => null);
    const amount = Number(body && typeof body === "object" ? (body as { amount?: unknown }).amount : NaN);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
      return c.json({ error: "invalid_amount", message: "amount must be a positive number (max 1e6)" }, 400);
    }

    const now = new Date().toISOString();
    const txId = randomUuid();

    db.prepare(
      `UPDATE api_keys
       SET credit_balance = credit_balance + ?,
           total_credits_purchased = total_credits_purchased + ?
       WHERE id = ?`,
    ).run(amount, amount, row.id);

    db.prepare(
      `INSERT INTO credit_transactions (id, api_key_id, amount, type, description, tempo_tx_hash, created_at)
       VALUES (?, ?, ?, 'dev_topup', 'Dev-only top-up (requires DEV_TOPUP_SECRET on server)', NULL, ?)`,
    ).run(txId, row.id, amount, now);

    const updated = db
      .prepare(`SELECT credit_balance FROM api_keys WHERE id = ?`)
      .get(row.id) as { credit_balance: number };

    return c.json({
      credit_balance: updated.credit_balance,
      amount_added: amount,
    });
  });

  r.get("/credits/usage", (c) => {
    const raw = extractApiKey(c);
    if (!raw) {
      return c.json({ error: "unauthorized", message: "Send Authorization: Bearer <api_key> or X-API-Key" }, 401);
    }
    const row = lookupApiKey(db, raw);
    if (!row) {
      return c.json({ error: "unauthorized", message: "Invalid or revoked API key" }, 401);
    }

    const limitRaw = c.req.query("limit");
    const limit = Math.min(500, Math.max(1, Number(limitRaw ?? "100") || 100));

    const rows = db
      .prepare(
        `SELECT id, amount, type, description, tempo_tx_hash, created_at
         FROM credit_transactions
         WHERE api_key_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(row.id, limit) as Array<{
        id: string;
        amount: number;
        type: string;
        description: string | null;
        tempo_tx_hash: string | null;
        created_at: string;
      }>;

    return c.json({
      org_id: row.org_id,
      transactions: rows,
    });
  });

  r.get("/credits/usage/summary", (c) => {
    const raw = extractApiKey(c);
    if (!raw) {
      return c.json({ error: "unauthorized", message: "Send Authorization: Bearer <api_key> or X-API-Key" }, 401);
    }
    const row = lookupApiKey(db, raw);
    if (!row) {
      return c.json({ error: "unauthorized", message: "Invalid or revoked API key" }, 401);
    }

    const daysRaw = c.req.query("days");
    const days = Math.min(90, Math.max(1, Number(daysRaw ?? "7") || 7));
    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    const byDay = db
      .prepare(
        `SELECT date(created_at) AS day,
                SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS credits_used,
                COUNT(CASE WHEN type = 'usage' THEN 1 END) AS usage_events
         FROM credit_transactions
         WHERE api_key_id = ? AND created_at >= ?
         GROUP BY date(created_at)
         ORDER BY day DESC`,
      )
      .all(row.id, since) as Array<{ day: string; credits_used: number; usage_events: number }>;

    const totals = db
      .prepare(
        `SELECT
           COUNT(CASE WHEN type = 'usage' THEN 1 END) AS usage_events,
           SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS credits_used,
           SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS credits_added
         FROM credit_transactions
         WHERE api_key_id = ?`,
      )
      .get(row.id) as {
      usage_events: number | null;
      credits_used: number | null;
      credits_added: number | null;
    };

    return c.json({
      org_id: row.org_id,
      email: row.email,
      credit_balance: row.credit_balance,
      total_credits_purchased: row.total_credits_purchased,
      total_credits_used: row.total_credits_used,
      window_days: days,
      totals: {
        usage_events: totals.usage_events ?? 0,
        credits_used: totals.credits_used ?? 0,
        credits_added: totals.credits_added ?? 0,
      },
      by_day: byDay,
    });
  });

  return r;
}
