# bds-agenthub-billing-metering

**Device-authorization** signup service for BDS agents (RFC 8628 style): human verifies once in a browser (captcha + ToS), agent receives an API key.

## Stack

- Node.js 20+, TypeScript, [Hono](https://hono.dev/)
- SQLite ([better-sqlite3](https://github.com/WiseLibs/better-sqlite3))
- Cloudflare Turnstile (required in production with `NODE_ENV=production`; optional locally if keys unset)

## Quick start

```bash
cp .env.example .env
# edit .env — set BASE_URL, PORT

npm install
npm run build
npm run dev
# or: node dist/index.js
```

Environment variables are read from **`.env` in the process working directory** (`dotenv` at startup). Existing `process.env` values are not overwritten. For production, you can also set vars via systemd, Docker, or the shell instead of `.env`.

## Configuration (Turnstile / captcha)

| Situation | Behavior |
|-----------|----------|
| **Both** `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` set | Captcha enforced (unless `SKIP_TURNSTILE=1`). |
| **Neither** key set, `NODE_ENV` is not `production` | Captcha is **skipped** (same UX as dev mode on `/verify`). A warning is printed at startup. |
| **`NODE_ENV=production`** and neither key set, **`SKIP_TURNSTILE` not set** | Process **exits at startup** — production must not run without Turnstile unless you explicitly set `SKIP_TURNSTILE=1`. |
| `SKIP_TURNSTILE=1` | Captcha skipped even if keys are present (emergencies / explicit local override). |

See `.env.example` for `BASE_URL`, `BILLING_TOPUP_URL`, `DEV_TOPUP_SECRET`, `INTERNAL_BILLING_SECRET`, `CREDIT_PER_*`, `FREE_TIER_CREDITS`, etc.

### Multi-chain payment verification (`PAYMENT_CHAINS_*`)

The service needs a **JSON array** of `{ "chain_id", "rpc_url", "recipient" }` for every chain it verifies on-chain (top-up, pay-signup). You can provide it in three ways (first match wins):

| Source | When to use |
|--------|-------------|
| **`PAYMENT_CHAINS_JSON_FILE`** | **Recommended for deploy** — path to a UTF-8 JSON file (same array shape). Relative paths are resolved from the process **working directory** (e.g. Docker `WORKDIR`). Overrides inline env below. |
| **`PAYMENT_CHAINS_JSON`** | Inline JSON string (e.g. in `.env`; escape quotes carefully). |
| *(neither set)* | Falls back to a **single chain** from `TEMPO_CHAIN_ID`, `TEMPO_RPC_URL` / `MPP_TEMPO_RPC_URL`, and `MPP_TEMPO_RECIPIENT`. |

Example file: `config/payment-chains.example.json` in this repo (copy to your secrets path and set `PAYMENT_CHAINS_JSON_FILE=/path/to/payment-chains.json`).

**Powerloom mainnet (EIP-155 `7869`, Arbitrum Nitro L2).** The fee token is **POWER** as the **custom gas token (CGT)** for that L2. That is **not** the same contract as the **Ethereum L1** ERC-20 POWER used in seeded plans for `chain_id` `1`—set `chain_id: 7869` with an RPC for the L2 (e.g. `https://rpc-v2.powerloom.network`) and the correct `recipient`; plan rows in SQLite must use the **7869** CGT token contract in `token_contract` when you add POWER-on-L2 pricing.

### Billing (SQL) + BDS Core API

- **Public**: `GET /credits/balance`, `GET /credits/usage`, `GET /credits/usage/summary?days=7` — same API key auth as balance.
- **Signup bonus:** `FREE_TIER_CREDITS` (default **2**) credits on first successful `/verify` — override in env.
- **Internal** (Core API only): `POST /internal/billing/deduct` — header `X-BDS-Internal-Billing-Secret` (must match env `INTERNAL_BILLING_SECRET`), forward the client’s `Authorization: Bearer sk_live_...`, JSON body `{ "path", "method" }`. Deducts `CREDIT_PER_STREAM_SESSION` for `/mpp/stream/...`, else `CREDIT_PER_EPOCH` (default **`10/7200`** credits per snapshot GET — i.e. **1 credit ≈ 720** such GETs at default pricing). Returns **402** if insufficient credits.

Configure Core API with `MPP_BILLING_MODE=signup_api`, `MPP_SIGNUP_BILLING_URL`, `MPP_INTERNAL_BILLING_SECRET` (same value as signup server).

## Web UI (`/metering`)

Browser signup + top-up shell (Next.js static export in `web/`, built into `web/out`). Served on the **same origin** as the API.

- **`npm run build`** runs **`build:web`** then compiles the server — run from repo root after `npm install` in `web/` (first time: `cd web && npm install`).
- Local: `GET http://127.0.0.1:<PORT>/metering/` — same routes as `POST /signup/initiate`, etc., without CORS.

**Production (Powerloom):** one deploy is proxied as **`https://bds-metering.powerloom.io`**. **`bds-agent signup`**, credits APIs, and device verification use the **origin** (set **`BDS_AGENT_SIGNUP_URL`** / **`--base-url`** to `https://bds-metering.powerloom.io`). The browser signup and billing shell is at **`https://bds-metering.powerloom.io/metering`**.

## HTTP routes (quick reference)

- Health: `GET /health`
- Initiate: `POST /signup/initiate` with `{ "email", "agent_name" }`
- Status: `GET /signup/status?session_token=...`
- Verify (browser): `GET /verify` and `POST /verify`
- Balance: `GET /credits/balance` with `Authorization: Bearer <api_key>` or `X-API-Key`
- Top-up: `POST /credits/topup` — returns billing info until checkout is integrated; optional `DEV_TOPUP_SECRET` + header `X-BDS-Dev-Topup-Secret` for dev-only credit adds (see `.env.example`)
- Usage: `GET /credits/usage?limit=100`, `GET /credits/usage/summary?days=7`
- Internal billing: `POST /internal/billing/deduct` (Core API + shared secret)

## API (summary)

Flow is modeled on [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628) (OAuth 2.0 device authorization). The agent calls `POST /signup/initiate`, prints `verification_url` and `user_code` for the human, then polls `GET /signup/status` until `approved` and an API key are returned. Human verification is `GET /verify` + `POST /verify` (captcha + ToS).

## License

Apache-2.0 (see `LICENSE`).
