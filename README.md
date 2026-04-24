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

**Powerloom mainnet (EIP-155 `7869`, Arbitrum Nitro L2).** The fee token is **POWER** as the **custom gas token (CGT)**. User payments are often a **plain native `value` send** (no ERC-20 `Transfer` logs). For those plans, set `payment_kind` to `native_value` in `credit_plans` and use `token_contract` = `0x0000000000000000000000000000000000000000` as a placeholder (amount is still `token_amount` / `token_decimals` for quotes and verification against `tx.value`). Ethereum L1 **ERC-20** POWER rows use `payment_kind` `erc20` (default).

**`GET /credits/plans` bundle:** `primary_recipient` / `primary_chain_id` / `primary_rpc_url` are the **primary** payment chain (`PAYMENT_CHAINS_PRIMARY_ID`, else `TEMPO_CHAIN_ID`, often **42431** Moderato). They are defaults for older single-chain clients and for the CLI Tempo top-up path; **each row in `plans[]` is authoritative** for that plan’s chain and `payment_kind`.

### How credit plans get into the DB (migrations + seed)

1. **Migrations** run automatically whenever the app opens the SQLite file (`openDb` in `src/db/client.ts` — also used by `npm run seed:plans`). You do **not** run a separate migration CLI. New columns (e.g. `payment_kind`) appear after deploy/restart or after running seed once.
2. **Default `CREDIT_PLANS_SOURCE` is `db`:** plans are read from the `credit_plans` table, not from env-only JSON.
3. **Fill / refresh plan rows** with the seed script (same `DB_PATH` the server uses):
   ```bash
   cd bds-agenthub-billing-metering
   export DB_PATH=/path/to/signup.db   # must match the running service
   npm run seed:plans
   ```
   This executes `src/scripts/seed-credit-plans.ts`, which `INSERT OR IGNORE`s rows from `src/lib/seed-credit-plans.ts` (`DEFAULT_CREDIT_PLAN_SEEDS`). Existing `(id, chain_id)` pairs are left unchanged; to change amounts or `payment_kind`, update the row in SQL or adjust the seed and use a new `id`, or delete the old row and seed again.
4. **Chain 7869 must be in payment config** (`PAYMENT_CHAINS_JSON(_FILE)`) with RPC + `recipient`, or the API will not expose or verify that chain even if a plan row exists.
5. **Optional:** set `CREDIT_PLANS_SOURCE=env` and provide plans only via `CREDIT_PLANS_JSON` (advanced; most deployments use the DB + seed).

The repo includes a **Powerloom 7869 native (CGT)** example row in `seed-credit-plans.ts` (`launch_10_pl_power_cgt`, `payment_kind: native_value`). Tune `token_amount` / `token_decimals` there, then re-run `npm run seed:plans` on a fresh row or after deleting the old PK row.

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
