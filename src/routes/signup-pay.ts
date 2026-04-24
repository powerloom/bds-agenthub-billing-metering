import Database from "better-sqlite3";
import { Hono } from "hono";
import type { AppConfig, CreditPlan } from "../config.js";
import { getPaymentChainById } from "../config.js";
import { resolveCreditPlansBundle } from "../lib/credit-plans-resolve.js";
import { randomApiKey, randomOrgId, randomUuid, randomSignupNonce, sha256Hex } from "../lib/crypto.js";
import { PAY_RAIL_PLACEHOLDER_SESSION_ID } from "../lib/pay-rail.js";
import { parseDecimalToAtomicUnits } from "../lib/parse-units.js";
import { verifyErc20Payment, verifyNativeValuePayment } from "../lib/payment-verify.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { redactRpcUrlForClient } from "../lib/rpc-redact.js";
import { validateAgentName, validateEmail } from "../lib/validate.js";
import type { SqliteDb } from "../types.js";

const HEX64 = /^0x[a-fA-F0-9]{64}$/;
const EVM_ADDR = /^0x[a-fA-F0-9]{40}$/;

function nowIso(): string {
  return new Date().toISOString();
}

function expiresAtIso(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function normalizeTxHash(h: string): string {
  const x = h.trim();
  if (!HEX64.test(x)) {
    throw new Error("invalid_tx_hash");
  }
  return x.toLowerCase();
}

function normalizeEvmAddress(a: string): string {
  const x = a.trim().toLowerCase();
  if (!EVM_ADDR.test(x)) {
    throw new Error("invalid_address");
  }
  return x;
}

function findPlanForPay(
  plans: CreditPlan[],
  planId: string,
  chainId: number,
  tokenSymbol: string,
): CreditPlan | undefined {
  const sym = tokenSymbol.trim().toLowerCase();
  return plans.find(
    (p) =>
      p.id === planId &&
      p.active &&
      p.chain_id === chainId &&
      Boolean(p.token_symbol) &&
      p.token_symbol!.trim().toLowerCase() === sym,
  );
}

type QuoteRow = {
  id: string;
  signup_nonce_hash: string;
  signup_nonce_raw: string | null;
  plan_id: string;
  chain_id: number;
  token_contract: string;
  token_symbol: string;
  token_decimals: number;
  amount_atomic: string;
  payer_address: string;
  recipient: string;
  terms_version: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  agent_name: string;
  email: string | null;
  payment_kind: string | null;
};

function quoteToJson(
  config: AppConfig,
  row: QuoteRow,
  rawNonce: string,
  plan: CreditPlan,
  rpcForHint: string,
): Record<string, unknown> {
  const native = plan.payment_kind === "native_value";
  return {
    signup_nonce: rawNonce,
    recipient: row.recipient,
    token_contract: row.token_contract,
    token_symbol: row.token_symbol,
    token_decimals: row.token_decimals,
    amount_atomic: row.amount_atomic,
    amount_human: plan.token_amount,
    chain_id: row.chain_id,
    payment_kind: native ? "native_value" : "erc20",
    rpc_hint: redactRpcUrlForClient(rpcForHint),
    expires_at: row.expires_at,
    terms_url: config.termsUrl,
    terms_version: row.terms_version,
    notice: native
      ? `Send at least the quoted **native** amount to \`recipient\` (chain gas token) within the expiry window, from \`payer_address\`, constitutes acceptance of terms ${row.terms_version}.`
      : `Sending the specified ERC-20 Transfer to \`recipient\` within the expiry window, from \`payer_address\`, constitutes acceptance of terms ${row.terms_version}.`,
  };
}

export function createSignupPayRoutes(db: SqliteDb, config: AppConfig) {
  const r = new Hono();
  const quoteByIp = createRateLimiter(60_000, 10);

  r.post("/signup/pay/quote", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "validation_failed", message: "Request body must be a JSON object." }, 400);
    }
    const o = body as Record<string, unknown>;
    const agentName = String(o.agent_name ?? "");
    const emailRaw = o.email != null && String(o.email).trim() !== "" ? String(o.email) : "";
    const planId = String(o.plan_id ?? "").trim();
    const tokenSymbol = String(o.token_symbol ?? "").trim();
    const payerAddressRaw = String(o.payer_address ?? "").trim();
    const chainIdBody = o.chain_id;
    let chainId = NaN;
    if (typeof chainIdBody === "number" && Number.isFinite(chainIdBody)) {
      chainId = Math.round(chainIdBody);
    } else if (typeof chainIdBody === "string" && chainIdBody.trim() !== "") {
      chainId = Math.round(Number(chainIdBody.trim()));
    }

    const aErr = validateAgentName(agentName);
    if (aErr) {
      return c.json(
        { error: "validation_failed", fields: { agent_name: aErr, email: null, plan_id: null } },
        400,
      );
    }
    if (!planId) {
      return c.json({ error: "validation_failed", message: "plan_id is required." }, 400);
    }
    if (!Number.isFinite(chainId) || chainId < 0) {
      return c.json({ error: "validation_failed", message: "chain_id is required and must be a number." }, 400);
    }
    if (!tokenSymbol) {
      return c.json({ error: "validation_failed", message: "token_symbol is required." }, 400);
    }
    let payerNorm: string;
    try {
      payerNorm = normalizeEvmAddress(payerAddressRaw);
    } catch {
      return c.json(
        { error: "validation_failed", message: "payer_address must be a 0x-prefixed 40-hex EVM address." },
        400,
      );
    }

    if (emailRaw) {
      const eErr = validateEmail(emailRaw);
      if (eErr) {
        return c.json(
          { error: "validation_failed", fields: { email: eErr, agent_name: null, plan_id: null } },
          400,
        );
      }
      const emailNorm = emailRaw.trim();
      const emailTaken = db
        .prepare(`SELECT 1 FROM api_keys WHERE lower(email) = lower(?) AND revoked_at IS NULL LIMIT 1`)
        .get(emailNorm);
      if (emailTaken !== undefined) {
        return c.json(
          {
            error: "email_already_registered",
            message:
              "An account with this email already exists. Use your existing API key, or contact support to recover access.",
          },
          409,
        );
      }
    }

    const payChain = getPaymentChainById(config, chainId);
    if (!payChain) {
      return c.json(
        { error: "unsupported_chain", message: `Chain ${chainId} is not configured for this deployment.` },
        400,
      );
    }

    const bundle = resolveCreditPlansBundle(db, config);
    const plan = findPlanForPay(bundle.plans, planId, chainId, tokenSymbol);
    if (!plan) {
      const hasId = bundle.plans.some((p) => p.id === planId && p.active && p.chain_id === chainId);
      if (!hasId) {
        return c.json(
          { error: "unknown_plan", message: `Unknown or inactive plan: ${planId} on chain ${chainId}.` },
          400,
        );
      }
      return c.json(
        {
          error: "unsupported_token",
          message: `Token symbol does not match this plan on chain ${chainId} (check GET /credits/plans for token_symbol).`,
        },
        400,
      );
    }

    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? c.req.header("cf-connecting-ip") ?? "unknown";
    const lim = quoteByIp(`payquote:${ip}`);
    if (!lim.ok) {
      return c.json(
        { error: "rate_limited", message: "Too many quote requests. Try again later.", retry_after_sec: lim.retryAfterSec },
        429,
      );
    }

    const now = nowIso();
    const existing = db
      .prepare(
        `SELECT * FROM signup_payment_quotes
         WHERE lower(payer_address) = ? AND plan_id = ? AND chain_id = ?
           AND consumed_at IS NULL AND expires_at > ?`,
      )
      .get(payerNorm, planId, chainId, now) as QuoteRow | undefined;

    if (existing?.signup_nonce_raw) {
      const rpcForHint = (plan.rpc_url && plan.rpc_url.trim()) || payChain.rpc_url;
      return c.json(quoteToJson(config, existing, existing.signup_nonce_raw, plan, rpcForHint), 200);
    }

    let minAtomic: bigint;
    try {
      minAtomic = parseDecimalToAtomicUnits(plan.token_amount, plan.token_decimals);
    } catch {
      return c.json({ error: "config_error", message: "Invalid plan token_amount/token_decimals on server." }, 500);
    }

    const rawNonce = randomSignupNonce();
    const nonceHash = sha256Hex(rawNonce);
    const id = randomUuid();
    const topupRecipient = (plan.recipient && plan.recipient.trim()) || payChain.recipient;
    if (!topupRecipient.trim()) {
      return c.json(
        {
          error: "payment_not_configured",
          message:
            "On-chain pay-signup is not configured (set recipient in payment chains file/env or per-plan row).",
        },
        503,
      );
    }
    const expiresAt = expiresAtIso(config.signupPayQuoteTtlSec);
    const createdAt = nowIso();
    const emailToStore = emailRaw.trim() || `pay-rail-anon+${payerNorm.slice(2)}@agent.local`;
    const termsV = config.termsVersion;

    try {
      const pKind = plan.payment_kind === "native_value" ? "native_value" : "erc20";
      db.prepare(
        `INSERT INTO signup_payment_quotes (
           id, signup_nonce_hash, signup_nonce_raw, agent_name, email, plan_id, chain_id,
           token_contract, token_symbol, token_decimals, amount_atomic, payer_address, recipient,
           terms_version, created_at, expires_at, payment_kind
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        nonceHash,
        rawNonce,
        agentName.trim(),
        emailRaw.trim() || null,
        planId,
        chainId,
        plan.token_contract,
        plan.token_symbol ?? tokenSymbol,
        plan.token_decimals,
        minAtomic.toString(),
        payerNorm,
        topupRecipient.trim(),
        termsV,
        createdAt,
        expiresAt,
        pKind,
      );
    } catch (e) {
      if (e instanceof Database.SqliteError && e.code === "SQLITE_CONSTRAINT_UNIQUE") {
        const again = db
          .prepare(
            `SELECT * FROM signup_payment_quotes
             WHERE lower(payer_address) = ? AND plan_id = ? AND chain_id = ?
               AND consumed_at IS NULL AND expires_at > ?`,
          )
          .get(payerNorm, planId, chainId, now) as QuoteRow | undefined;
        if (again?.signup_nonce_raw) {
          const rpcForHint2 = (plan.rpc_url && plan.rpc_url.trim()) || payChain.rpc_url;
          return c.json(quoteToJson(config, again, again.signup_nonce_raw, plan, rpcForHint2), 200);
        }
      }
      throw e;
    }

    const row = db
      .prepare(`SELECT * FROM signup_payment_quotes WHERE id = ?`)
      .get(id) as QuoteRow;
    const rpcForHint3 = (plan.rpc_url && plan.rpc_url.trim()) || payChain.rpc_url;
    return c.json(quoteToJson(config, row, rawNonce, plan, rpcForHint3), 201);
  });

  r.post("/signup/pay/claim", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "validation_failed", message: "Request body must be a JSON object." }, 400);
    }
    const o = body as Record<string, unknown>;
    const signupNonce = String(o.signup_nonce ?? "").trim();
    const txHashRaw = String(o.tx_hash ?? "").trim();
    if (!signupNonce) {
      return c.json({ error: "validation_failed", message: "signup_nonce is required." }, 400);
    }
    if (!txHashRaw) {
      return c.json({ error: "validation_failed", message: "tx_hash is required." }, 400);
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

    const h = sha256Hex(signupNonce);
    const row = db.prepare(`SELECT * FROM signup_payment_quotes WHERE signup_nonce_hash = ?`).get(h) as
      | (QuoteRow & { consumed_at: string | null; api_key_id: string | null; claim_tx_hash: string | null })
      | undefined;
    if (!row) {
      return c.json({ error: "not_found", message: "Quote not found or already claimed." }, 404);
    }
    if (row.consumed_at) {
      return c.json({ error: "not_found", message: "Quote not found or already claimed." }, 404);
    }

    const now = nowIso();
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      return c.json({ error: "quote_expired", message: "This pay-signup quote has expired. Request a new quote." }, 410);
    }

    const payChain = getPaymentChainById(config, row.chain_id);
    if (!payChain) {
      return c.json(
        { error: "chain_not_configured", message: `Chain ${row.chain_id} is not configured on this server.` },
        503,
      );
    }

    const bundle = resolveCreditPlansBundle(db, config);
    const plan = findPlanForPay(bundle.plans, row.plan_id, row.chain_id, row.token_symbol);
    if (!plan) {
      return c.json({ error: "config_error", message: "Plan for this quote is no longer available." }, 500);
    }

    const rpcUrl = (plan.rpc_url && plan.rpc_url.trim()) || payChain.rpc_url;
    const recipient = row.recipient.trim();
    let minAtomic: bigint;
    try {
      minAtomic = BigInt(row.amount_atomic);
    } catch {
      return c.json({ error: "config_error", message: "Invalid amount_atomic on quote." }, 500);
    }

    const useNative = plan.payment_kind === "native_value" || row.payment_kind === "native_value";
    const verified = useNative
      ? await verifyNativeValuePayment(rpcUrl, txHash, plan.chain_id, recipient, minAtomic, {
          expectedPayer: row.payer_address,
        })
      : await verifyErc20Payment(
          rpcUrl,
          txHash,
          plan.chain_id,
          plan.token_contract,
          recipient,
          minAtomic,
          { expectedPayer: row.payer_address },
        );
    if (!verified.ok) {
      return c.json({ error: verified.error, message: verified.message }, verified.http as 400 | 502);
    }

    const dupPayer = db
      .prepare(
        `SELECT 1 FROM api_keys WHERE lower(payer_address) = lower(?) AND revoked_at IS NULL LIMIT 1`,
      )
      .get(row.payer_address);
    if (dupPayer !== undefined) {
      return c.json(
        { error: "payer_already_registered", message: "This wallet address already has an active API key." },
        409,
      );
    }

    const dupTx = db.prepare(`SELECT 1 FROM credit_transactions WHERE tx_hash = ? LIMIT 1`).get(txHash);
    if (dupTx !== undefined) {
      return c.json(
        { error: "tx_already_used", message: "This transaction hash was already used for a credit or signup event." },
        409,
      );
    }

    const rawKey = randomApiKey();
    const keyHash = sha256Hex(rawKey);
    const orgId = randomOrgId();
    const keyId = randomUuid();
    const bonus = config.freeTierCredits;
    const purchased = plan.credits;
    const balance = purchased + bonus;
    const emailToStore = row.email?.trim() || `pay-rail-anon+${row.payer_address.slice(2)}@agent.local`;
    const ts = nowIso();

    try {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO api_keys (
             id, session_id, email, api_key_hash, api_key_raw, org_id, payer_address,
             credit_balance, total_credits_purchased, total_credits_used,
             rate_limit_rpm, rate_limit_rpd, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 60, 1000, ?)`,
        ).run(
          keyId,
          PAY_RAIL_PLACEHOLDER_SESSION_ID,
          emailToStore,
          keyHash,
          rawKey,
          orgId,
          row.payer_address,
          balance,
          purchased,
          ts,
        );

        const txPurchase = randomUuid();
        db.prepare(
          `INSERT INTO credit_transactions (
             id, api_key_id, amount, type, description, tx_hash, chain_id, plan_id, created_at
           ) VALUES (?, ?, ?, 'purchase_pay_signup', ?, ?, ?, ?, ?)`,
        ).run(txPurchase, keyId, purchased, `Pay-signup plan ${row.plan_id}`, txHash, row.chain_id, row.plan_id, ts);

        const txBonus = randomUuid();
        db.prepare(
          `INSERT INTO credit_transactions (
             id, api_key_id, amount, type, description, tx_hash, chain_id, plan_id, created_at
           ) VALUES (?, ?, ?, 'signup_bonus', 'Signup bonus credits', NULL, NULL, NULL, ?)`,
        ).run(txBonus, keyId, bonus, ts);

        db.prepare(
          `UPDATE signup_payment_quotes SET consumed_at = ?, api_key_id = ?, claim_tx_hash = ?, signup_nonce_raw = NULL WHERE id = ?`,
        ).run(ts, keyId, txHash, row.id);
      })();
    } catch (e) {
      if (e instanceof Database.SqliteError && (e.code === "SQLITE_CONSTRAINT_UNIQUE" || e.code === "SQLITE_CONSTRAINT")) {
        return c.json(
          { error: "conflict", message: "Could not complete signup (duplicate). Retry or contact support." },
          409,
        );
      }
      throw e;
    }

    return c.json({
      status: "approved",
      api_key: rawKey,
      org_id: orgId,
      rate_limits: {
        requests_per_minute: 60,
        requests_per_day: 1000,
      },
      credit_balance: balance,
      plan_id: row.plan_id,
      tx_hash: txHash,
      chain_id: row.chain_id,
    });
  });

  return r;
}
