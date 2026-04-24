import { Hono } from "hono";
import type { AppConfig } from "../config.js";
import type { SqliteDb } from "../types.js";
import { verifyTurnstile } from "../lib/captcha.js";
import { randomApiKey, randomOrgId, randomUuid, sha256Hex } from "../lib/crypto.js";
import { normalizeUserCode } from "../lib/validate.js";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function verifyPage(config: AppConfig, prefill: string, error: string | null): string {
  const siteKey = config.turnstileSiteKey;
  const turnstileScript =
    siteKey && !config.skipTurnstile
      ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`
      : "";
  const turnstileWidget =
    siteKey && !config.skipTurnstile
      ? `<div class="cf-turnstile" data-sitekey="${esc(siteKey)}" data-theme="auto"></div>`
      : config.skipTurnstile
        ? `<p class="hint">Dev mode: captcha skipped (SKIP_TURNSTILE)</p><input type="hidden" name="captcha_token" value="dev" />`
        : `<p class="err">Turnstile not configured. Set TURNSTILE_SITE_KEY or SKIP_TURNSTILE=1 for dev.</p>`;

  const errBlock = error ? `<p class="err">${esc(error)}</p>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Verify — BDS API</title>
${turnstileScript}
<style>
:root { --bg:#fafaf8; --card:#f3f2ee; --border:#d8d6cf; --text:#1a1a18; --muted:#6b6a65; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#19191a; --card:#242425; --border:#3a3a3b; --text:#e8e6de; --muted:#9c9a92; }
}
body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 2rem; }
.card { max-width: 480px; margin: 0 auto; background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; }
h1 { font-size: 1.15rem; margin: 0 0 0.5rem; }
p.lead { color: var(--muted); font-size: 0.9rem; margin: 0 0 1.25rem; }
label { display: block; font-size: 0.85rem; margin-bottom: 0.35rem; }
input[type=text] { width: 100%; box-sizing: border-box; padding: 0.6rem 0.75rem; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 1rem; }
.tos { max-height: 120px; overflow: auto; font-size: 0.8rem; color: var(--muted); border: 1px solid var(--border); padding: 0.75rem; border-radius: 8px; margin: 1rem 0; }
button { width: 100%; margin-top: 1rem; padding: 0.65rem; border-radius: 8px; border: none; background: #534ab7; color: #fff; font-weight: 600; cursor: pointer; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.err { color: #b42318; font-size: 0.9rem; }
.hint { font-size: 0.8rem; color: var(--muted); }
</style>
</head>
<body>
<div class="card">
  <h1>Activate your API key</h1>
  <p class="lead">Complete verification to activate your BDS agent API key.</p>
  ${errBlock}
  <form method="post" action="/verify" id="vf">
    <label for="user_code">User code</label>
    <input type="text" id="user_code" name="user_code" value="${esc(prefill)}" placeholder="ABCD-1234" autocomplete="one-time-code" required />
    ${turnstileWidget}
    <div class="tos">
      <strong>Terms of Service (summary)</strong><br/>
      Use of the API is subject to fair use and rate limits. Do not abuse or resell access without agreement.
      Full terms: <a href="https://powerloom.io/terms" target="_blank" rel="noopener">powerloom.io/terms</a>
    </div>
    <label><input type="checkbox" name="tos_accepted" value="true" required /> I agree to the Terms and Privacy Policy.</label>
    <button type="submit" id="btn">Verify</button>
  </form>
</div>
</body>
</html>`;
}

function successPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Verified</title>
<style>
body{font-family:system-ui,sans-serif;background:#fafaf8;color:#1a1a18;margin:0;padding:2rem;text-align:center;}
@media (prefers-color-scheme: dark){body{background:#19191a;color:#e8e6de;}}
p{max-width:420px;margin:2rem auto;line-height:1.6;}
</style></head>
<body>
<p><strong>Verification complete.</strong> You can close this tab. Your agent will receive the API key when it polls <code>/signup/status</code>.</p>
</body></html>`;
}

export function createVerifyRoutes(db: SqliteDb, config: AppConfig) {
  const r = new Hono();

  r.get("/verify", (c) => {
    const code = c.req.query("code") ?? "";
    const prefill = normalizeUserCode(code);
    return c.html(verifyPage(config, prefill, null));
  });

  r.post("/verify", async (c) => {
    const ct = c.req.header("content-type") ?? "";
    let userCode = "";
    let captchaToken = "";
    let tosAccepted = false;

    if (ct.includes("application/json")) {
      const body = await c.req.json().catch(() => null);
      if (body && typeof body === "object") {
        userCode = String((body as { user_code?: string }).user_code ?? "");
        captchaToken = String((body as { captcha_token?: string }).captcha_token ?? "");
        tosAccepted = Boolean((body as { tos_accepted?: boolean }).tos_accepted);
      }
    } else {
      const form = await c.req.parseBody();
      const f = form as Record<string, unknown>;
      userCode = String(f.user_code ?? "");
      captchaToken = String(
        f["cf-turnstile-response"] ?? f.captcha_token ?? "",
      );
      const tos = f.tos_accepted;
      tosAccepted = tos === true || String(tos ?? "") === "true";
    }

    const normalized = normalizeUserCode(userCode);
    const now = new Date().toISOString();

    const row = db
      .prepare(
        `SELECT * FROM signup_sessions WHERE user_code = ? AND status = 'pending' AND expires_at > ?`,
      )
      .get(normalized, now) as Record<string, unknown> | undefined;

    if (!row) {
      const html = verifyPage(config, normalized, "Invalid or expired code. Ask your agent to start a new signup.");
      return c.html(html, 400);
    }

    if (!tosAccepted) {
      const html = verifyPage(config, normalized, "You must accept the Terms of Service.");
      return c.html(html, 400);
    }

    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? "";
    const ua = c.req.header("user-agent") ?? "";

    const ok = await verifyTurnstile(config, captchaToken, ip || undefined);
    if (!ok) {
      const html = verifyPage(config, normalized, "Captcha verification failed. Please try again.");
      return c.html(html, 400);
    }

    const sessionId = String(row.id);
    const email = String(row.email);

    const rawKey = randomApiKey();
    const keyHash = sha256Hex(rawKey);
    const orgId = randomOrgId();
    const keyId = randomUuid();
    const credits = config.freeTierCredits;

    db.prepare(
      `UPDATE signup_sessions SET status = 'approved', verified_at = ?, ip_address = ?, user_agent = ? WHERE id = ?`,
    ).run(now, ip, ua, sessionId);

    db.prepare(
      `INSERT INTO api_keys (
        id, session_id, email, api_key_hash, api_key_raw, org_id,
        credit_balance, total_credits_purchased, total_credits_used,
        rate_limit_rpm, rate_limit_rpd, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 60, 1000, ?)`,
    ).run(keyId, sessionId, email, keyHash, rawKey, orgId, credits, now);

    const txId = randomUuid();
    db.prepare(
      `INSERT INTO credit_transactions (
         id, api_key_id, amount, type, description, tx_hash, chain_id, plan_id, created_at
       ) VALUES (?, ?, ?, 'signup_bonus', 'Free tier credits on signup', NULL, NULL, NULL, ?)`,
    ).run(txId, keyId, credits, now);

    return c.html(successPage());
  });

  return r;
}
