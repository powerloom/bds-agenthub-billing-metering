import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDb } from "./db/client.js";
import { createApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { randomApiKey, sha256Hex } from "./lib/crypto.js";
import { buildUsageMetadata } from "./lib/usage-metadata.js";

function testConfig(): AppConfig {
  return {
    port: 8787,
    baseUrl: "http://127.0.0.1:8787",
    sessionTtlSeconds: 600,
    freeTierCredits: 2,
    turnstileSiteKey: "",
    turnstileSecretKey: "",
    skipTurnstile: true,
    billingTopupUrl: "https://powerloom.io",
    devTopupSecret: "",
    internalBillingSecret: "test-internal-secret",
    creditPerEpoch: 1 / 7200,
    creditPerStreamSession: 0.01,
    creditPlansFallback: {
      plans: [],
      chains: [],
      primary_chain_id: 42431,
      primary_recipient: "",
      primary_rpc_url: "",
      terms_url: "http://127.0.0.1:8787/terms",
      terms_version: "v1",
      epoch_unit: {
        credits_per_epoch: 1 / 7200,
        epochs_per_credit: 7200,
        note: "test",
      },
    },
    creditPlansSource: "db",
    creditTopupRatePerMinute: 10,
    paymentChains: [],
    paymentChainsPrimaryId: 42431,
    termsUrl: "http://127.0.0.1:8787/terms",
    termsVersion: "v1",
    signupPayQuoteTtlSec: 1800,
    apiKeyRecoveryChallengeTtlSec: 600,
  };
}

function seedApiKey(db: ReturnType<typeof openDb>, balance = 10): { id: string; rawKey: string } {
  const rawKey = randomApiKey();
  const id = "key-test-1";
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO signup_sessions (
       id, email, agent_name, session_token_hash, session_token_raw, user_code,
       status, created_at, expires_at, verified_at, credentials_delivered
     ) VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, 1)`,
  ).run(id, "test@example.com", "agent", sha256Hex("sess"), "sess", "ABCD-EFGH", now, now, now);
  db.prepare(
    `INSERT INTO api_keys (
       id, session_id, email, api_key_hash, org_id, credit_balance,
       total_credits_purchased, total_credits_used, rate_limit_rpm, rate_limit_rpd, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 60, 1000, ?)`,
  ).run(id, id, "test@example.com", sha256Hex(rawKey), "org_test", balance, now);
  return { id, rawKey };
}

test("buildUsageMetadata stores route template and client source", () => {
  const meta = buildUsageMetadata({
    path: "/mpp/snapshot/allTrades/123",
    method: "get",
    route_template: "/mpp/snapshot/allTrades/{block_number}",
    client_source: "cli",
  });
  assert.equal(meta.httpMethod, "GET");
  assert.equal(meta.routeTemplate, "/mpp/snapshot/allTrades/{block_number}");
  assert.equal(meta.clientSource, "cli");
  assert.equal(meta.requestPath, "/mpp/snapshot/allTrades/123");
});

test("deduct persists structured usage and summary rolls up by endpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "metering-test-"));
  const dbPath = join(dir, "test.db");
  const db = openDb(dbPath);
  const config = testConfig();
  const app = createApp(db, config);
  const { rawKey } = seedApiKey(db);

  const deductRes = await app.request("http://test/internal/billing/deduct", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${rawKey}`,
      "X-BDS-Internal-Billing-Secret": config.internalBillingSecret,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      path: "/mpp/snapshot/allTrades/999",
      method: "GET",
      route_template: "/mpp/snapshot/allTrades/{block_number}",
      client_source: "mcp",
    }),
  });
  assert.equal(deductRes.status, 200);

  const summaryRes = await app.request("http://test/credits/usage/summary?days=7", {
    headers: { Authorization: `Bearer ${rawKey}` },
  });
  assert.equal(summaryRes.status, 200);
  const summary = (await summaryRes.json()) as {
    by_endpoint: Array<{ route_template: string; call_count: number }>;
  };
  assert.equal(summary.by_endpoint.length, 1);
  assert.equal(summary.by_endpoint[0]!.route_template, "/mpp/snapshot/allTrades/{block_number}");
  assert.equal(summary.by_endpoint[0]!.call_count, 1);

  const byEndpointRes = await app.request("http://test/credits/usage/by-endpoint?days=7", {
    headers: { Authorization: `Bearer ${rawKey}` },
  });
  assert.equal(byEndpointRes.status, 200);

  rmSync(dir, { recursive: true, force: true });
});

test("migrate adds usage columns idempotently", () => {
  const dir = mkdtempSync(join(tmpdir(), "metering-migrate-"));
  const dbPath = join(dir, "test.db");
  const db1 = openDb(dbPath);
  db1.close();
  const db2 = openDb(dbPath);
  const cols = db2
    .prepare(`PRAGMA table_info(credit_transactions)`)
    .all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  assert.ok(names.has("route_template"));
  assert.ok(names.has("client_source"));
  db2.close();
  rmSync(dir, { recursive: true, force: true });
});
