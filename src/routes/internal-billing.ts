import { Hono } from "hono";
import type { AppConfig } from "../config.js";
import { extractApiKey, lookupApiKey } from "../lib/auth.js";
import { randomUuid } from "../lib/crypto.js";
import { buildUsageMetadata } from "../lib/usage-metadata.js";
import { createUsageRateLimiter } from "../lib/usage-rate-limit.js";
import type { SqliteDb } from "../types.js";

const MAX_CREDIT_WEIGHT = 1000;

function parseCreditWeight(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") {
    return 1;
  }
  const w = Number(raw);
  if (!Number.isFinite(w) || w <= 0) {
    return 1;
  }
  return Math.min(w, MAX_CREDIT_WEIGHT);
}

/** Debit = CREDIT_PER_EPOCH × catalog credit_weight (from Core API). Stream uses flat session rate. */
function deductAmountForRequest(
  config: AppConfig,
  path: string,
  creditWeightRaw: unknown,
): number {
  const p = path.startsWith("/") ? path : `/${path}`;
  if (p.startsWith("/mpp/stream/")) {
    return config.creditPerStreamSession;
  }
  return config.creditPerEpoch * parseCreditWeight(creditWeightRaw);
}

export function createInternalBillingRoutes(db: SqliteDb, config: AppConfig) {
  const r = new Hono();
  const checkUsageRateLimit = createUsageRateLimiter();

  /**
   * Called by BDS Core API (MPP middleware) before serving /mpp/... routes.
   * Authenticates with X-BDS-Internal-Billing-Secret; deducts credits for the
   * API key in Authorization (same header the client sent to Core API).
   */
  r.post("/internal/billing/deduct", async (c) => {
    const secret = c.req.header("X-BDS-Internal-Billing-Secret") ?? "";
    if (!config.internalBillingSecret || secret !== config.internalBillingSecret) {
      return c.json({ error: "forbidden", message: "Invalid or missing internal billing secret" }, 403);
    }

    const raw = extractApiKey(c);
    if (!raw) {
      return c.json(
        { error: "unauthorized", message: "Forward Authorization: Bearer <api_key> from the client" },
        401,
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const usage = buildUsageMetadata({
      path: obj.path,
      method: obj.method,
      route_template: obj.route_template,
      client_source: obj.client_source,
    });

    const row = lookupApiKey(db, raw);
    if (!row) {
      return c.json({ error: "unauthorized", message: "Invalid or revoked API key" }, 401);
    }

    const rateLimits = {
      requests_per_minute: row.rate_limit_rpm,
      requests_per_day: row.rate_limit_rpd,
    };
    const rl = checkUsageRateLimit(row.id, row.rate_limit_rpm, row.rate_limit_rpd);
    if (!rl.ok) {
      const windowLabel = rl.window === "minute" ? "minute" : "day";
      return c.json(
        {
          error: "rate_limited",
          message: `API rate limit exceeded (${row.rate_limit_rpm}/min, ${row.rate_limit_rpd}/day)`,
          rate_limits: rateLimits,
          retry_after_sec: rl.retryAfterSec,
          limit_window: windowLabel,
        },
        429,
        { "Retry-After": String(rl.retryAfterSec) },
      );
    }

    const amount = deductAmountForRequest(
      config,
      usage.requestPath || "/mpp/snapshot",
      obj.credit_weight,
    );
    if (!Number.isFinite(amount) || amount <= 0) {
      return c.json({ error: "config_error", message: "Invalid credit amounts in server config" }, 500);
    }

    const now = new Date().toISOString();
    const txId = randomUuid();

    const run = db.transaction(() => {
      const cur = db
        .prepare(`SELECT credit_balance FROM api_keys WHERE id = ? AND revoked_at IS NULL`)
        .get(row.id) as { credit_balance: number } | undefined;
      if (!cur) {
        throw new Error("key_missing");
      }
      if (cur.credit_balance < amount) {
        return { ok: false as const, balance: cur.credit_balance };
      }
      db.prepare(
        `UPDATE api_keys
         SET credit_balance = credit_balance - ?,
             total_credits_used = total_credits_used + ?
         WHERE id = ?`,
      ).run(amount, amount, row.id);
      db.prepare(
        `INSERT INTO credit_transactions (
           id, api_key_id, amount, type, description,
           http_method, route_template, request_path, client_source,
           tx_hash, chain_id, plan_id, created_at
         ) VALUES (?, ?, ?, 'usage', ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
      ).run(
        txId,
        row.id,
        -amount,
        usage.description,
        usage.httpMethod,
        usage.routeTemplate,
        usage.requestPath,
        usage.clientSource,
        now,
      );
      const after = db
        .prepare(`SELECT credit_balance FROM api_keys WHERE id = ?`)
        .get(row.id) as { credit_balance: number };
      return { ok: true as const, balance: after.credit_balance, amount_charged: amount };
    });

    try {
      const out = run();
      if (!out.ok) {
        return c.json(
          {
            error: "insufficient_credits",
            message: "Add credits via bds-agent credits topup or billing when available",
            credit_balance: out.balance,
            required: amount,
          },
          402,
        );
      }
      return c.json({
        ok: true,
        credit_balance: out.balance,
        amount_charged: out.amount_charged,
        org_id: row.org_id,
      });
    } catch (e) {
      if (String(e).includes("key_missing")) {
        return c.json({ error: "unauthorized" }, 401);
      }
      throw e;
    }
  });

  /**
   * Debug: resolve API key hash without deducting (optional; same internal secret).
   */
  r.post("/internal/billing/lookup", async (c) => {
    const secret = c.req.header("X-BDS-Internal-Billing-Secret") ?? "";
    if (!config.internalBillingSecret || secret !== config.internalBillingSecret) {
      return c.json({ error: "forbidden" }, 403);
    }
    const raw = extractApiKey(c);
    if (!raw) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const row = lookupApiKey(db, raw);
    if (!row) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json({
      org_id: row.org_id,
      email: row.email,
      credit_balance: row.credit_balance,
    });
  });

  return r;
}
