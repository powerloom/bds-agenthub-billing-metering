import Database from "better-sqlite3";
import { Hono } from "hono";
import type { AppConfig, CreditPlan, CreditPlansBundle } from "../config.js";
import { getPaymentChainById } from "../config.js";
import { resolveCreditPlansBundle } from "../lib/credit-plans-resolve.js";
import { extractApiKey, lookupApiKey } from "../lib/auth.js";
import { randomUuid } from "../lib/crypto.js";
import { parseDecimalToAtomicUnits } from "../lib/parse-units.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { verifyErc20Payment } from "../lib/payment-verify.js";
import type { SqliteDb } from "../types.js";

const HEX64 = /^0x[a-fA-F0-9]{64}$/;

function normalizeTxHash(h: string): string {
  const x = h.trim();
  if (!HEX64.test(x)) {
    throw new Error("invalid_tx_hash");
  }
  return x.toLowerCase();
}

function findPlan(bundle: CreditPlansBundle, planId: string, chainId: number): CreditPlan | undefined {
  return bundle.plans.find((p) => p.id === planId && p.active && p.chain_id === chainId);
}

export function createCreditsRoutes(db: SqliteDb, config: AppConfig) {
  const r = new Hono();
  const topupLimiter = createRateLimiter(60_000, config.creditTopupRatePerMinute);

  r.get("/credits/plans", (c) => {
    return c.json(resolveCreditPlansBundle(db, config));
  });

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

    const body = await c.req.json().catch(() => null);
    const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : null;

    const planId = obj && typeof obj.plan_id === "string" ? obj.plan_id.trim() : "";
    const txHashRaw = obj && typeof obj.tx_hash === "string" && obj.tx_hash.trim() !== "" ? obj.tx_hash.trim() : "";
    const chainIdBody = obj ? (obj as Record<string, unknown>).chain_id : undefined;
    let requestChainId = NaN;
    if (typeof chainIdBody === "number" && Number.isFinite(chainIdBody)) {
      requestChainId = chainIdBody;
    } else if (typeof chainIdBody === "string" && chainIdBody.trim() !== "") {
      requestChainId = Number(chainIdBody.trim());
    }

    const hasOnchainPayload = Boolean(planId && txHashRaw && Number.isFinite(requestChainId));

    const devSecret = config.devTopupSecret;
    const headerSecret = c.req.header("X-BDS-Dev-Topup-Secret") ?? "";
    const wantsDev =
      devSecret &&
      headerSecret === devSecret &&
      obj &&
      typeof obj.amount === "number" &&
      Number.isFinite(obj.amount);

    if (hasOnchainPayload) {
      const bundle = resolveCreditPlansBundle(db, config);
      const lim = topupLimiter(`topup:${row.id}`);
      if (!lim.ok) {
        return c.json(
          { error: "rate_limited", message: "Too many top-up attempts. Try again later.", retry_after_sec: lim.retryAfterSec },
          429,
        );
      }

      const planChain = Math.round(requestChainId);
      const plan = findPlan(bundle, planId, planChain);
      if (!plan) {
        return c.json(
          {
            error: "unknown_plan",
            message: `Unknown or inactive plan for plan_id and chain_id: ${planId} on chain ${planChain}.`,
          },
          400,
        );
      }

      const payChain = getPaymentChainById(config, plan.chain_id);
      if (!payChain) {
        return c.json(
          {
            error: "chain_not_configured",
            message: `Chain ${plan.chain_id} is not in the configured payment chains (file/env or TEMPO_* single-chain config).`,
          },
          503,
        );
      }

      const rpcUrl = (plan.rpc_url && plan.rpc_url.trim()) || payChain.rpc_url;
      const topupRecipient = (plan.recipient && plan.recipient.trim()) || payChain.recipient;
      if (!topupRecipient.trim()) {
        return c.json(
          {
            error: "payment_not_configured",
            message:
              "On-chain top-up is not configured (set recipient in payment chains file/env or MPP_TEMPO_RECIPIENT).",
          },
          503,
        );
      }

      let txHash: string;
      try {
        txHash = normalizeTxHash(txHashRaw);
      } catch {
        return c.json(
          { error: "invalid_tx_hash", message: "tx_hash must be a 32-byte hex string with 0x prefix." },
          400,
        );
      }

      let minAtomic: bigint;
      try {
        minAtomic = parseDecimalToAtomicUnits(plan.token_amount, plan.token_decimals);
      } catch {
        return c.json({ error: "config_error", message: "Invalid plan token_amount/token_decimals on server." }, 500);
      }

      const verified = await verifyErc20Payment(
        rpcUrl,
        txHash,
        plan.chain_id,
        plan.token_contract,
        topupRecipient,
        minAtomic,
      );
      if (!verified.ok) {
        return c.json({ error: verified.error, message: verified.message }, verified.http as 400 | 502);
      }

      const now = new Date().toISOString();
      const txRowId = randomUuid();
      const credits = plan.credits;

      try {
        db.transaction(() => {
          db.prepare(
            `INSERT INTO credit_transactions (
               id, api_key_id, amount, type, description, tx_hash, chain_id, plan_id, created_at
             ) VALUES (?, ?, ?, 'purchase_tempo', ?, ?, ?, ?, ?)`,
          ).run(
            txRowId,
            row.id,
            credits,
            `On-chain purchase plan ${plan.id}`,
            txHash,
            plan.chain_id,
            plan.id,
            now,
          );
          db.prepare(
            `UPDATE api_keys
             SET credit_balance = credit_balance + ?,
                 total_credits_purchased = total_credits_purchased + ?
             WHERE id = ?`,
          ).run(credits, credits, row.id);
        })();
      } catch (e) {
        if (e instanceof Database.SqliteError && e.code === "SQLITE_CONSTRAINT_UNIQUE") {
          return c.json(
            { error: "duplicate_tx", message: "This transaction hash was already used for a top-up." },
            409,
          );
        }
        throw e;
      }

      const updated = db
        .prepare(`SELECT credit_balance, total_credits_purchased FROM api_keys WHERE id = ?`)
        .get(row.id) as { credit_balance: number; total_credits_purchased: number };

      return c.json({
        credit_balance: updated.credit_balance,
        amount_added: credits,
        total_credits_purchased: updated.total_credits_purchased,
        plan_id: plan.id,
        tx_hash: txHash,
      });
    }

    if (wantsDev) {
      const amount = Number((obj as { amount: number }).amount);
      if (amount <= 0 || amount > 1_000_000) {
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
        `INSERT INTO credit_transactions (
           id, api_key_id, amount, type, description, tx_hash, chain_id, plan_id, created_at
         ) VALUES (?, ?, ?, 'dev_topup', 'Dev-only top-up (requires DEV_TOPUP_SECRET on server)', NULL, NULL, NULL, ?)`,
      ).run(txId, row.id, amount, now);

      const updated = db
        .prepare(`SELECT credit_balance FROM api_keys WHERE id = ?`)
        .get(row.id) as { credit_balance: number };

      return c.json({
        credit_balance: updated.credit_balance,
        amount_added: amount,
      });
    }

    return c.json(
      {
        error: "checkout_not_available",
        message:
          "Send { plan_id, tx_hash, chain_id } after on-chain payment, or use dev top-up with X-BDS-Dev-Topup-Secret when configured.",
        billing_url: config.billingTopupUrl,
        plans_url: `${config.baseUrl}/credits/plans`,
      },
      501,
    );
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
        `SELECT id, amount, type, description, tx_hash, chain_id, plan_id, created_at
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
        tx_hash: string | null;
        chain_id: number | null;
        plan_id: string | null;
        created_at: string;
      }>;

    return c.json({
      org_id: row.org_id,
      transactions: rows.map((t) => ({
        id: t.id,
        amount: t.amount,
        type: t.type,
        description: t.description,
        tx_hash: t.tx_hash,
        chain_id: t.chain_id,
        plan_id: t.plan_id,
        created_at: t.created_at,
      })),
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
