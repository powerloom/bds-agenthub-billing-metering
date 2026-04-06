# bds-agent-signup

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

## Configuration (Turnstile / captcha)

| Situation | Behavior |
|-----------|----------|
| **Both** `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` set | Captcha enforced (unless `SKIP_TURNSTILE=1`). |
| **Neither** key set, `NODE_ENV` is not `production` | Captcha is **skipped** (same UX as dev mode on `/verify`). A warning is printed at startup. |
| **`NODE_ENV=production`** and neither key set, **`SKIP_TURNSTILE` not set** | Process **exits at startup** — production must not run without Turnstile unless you explicitly set `SKIP_TURNSTILE=1`. |
| `SKIP_TURNSTILE=1` | Captcha skipped even if keys are present (emergencies / explicit local override). |

See `.env.example` for `BASE_URL`, `BILLING_TOPUP_URL`, `DEV_TOPUP_SECRET`, etc.

## HTTP routes (quick reference)

- Health: `GET /health`
- Initiate: `POST /signup/initiate` with `{ "email", "agent_name" }`
- Status: `GET /signup/status?session_token=...`
- Verify (browser): `GET /verify` and `POST /verify`
- Balance: `GET /credits/balance` with `Authorization: Bearer <api_key>` or `X-API-Key`
- Top-up: `POST /credits/topup` — returns billing info until checkout is integrated; optional `DEV_TOPUP_SECRET` + header `X-BDS-Dev-Topup-Secret` for dev-only credit adds (see `.env.example`)

## API (summary)

Flow is modeled on [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628) (OAuth 2.0 device authorization). The agent calls `POST /signup/initiate`, prints `verification_url` and `user_code` for the human, then polls `GET /signup/status` until `approved` and an API key are returned. Human verification is `GET /verify` + `POST /verify` (captcha + ToS).

## License

Apache-2.0 (see `LICENSE`).
