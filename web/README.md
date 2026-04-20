# Metering web UI (`/metering`)

Next.js **static export** (App Router) served by the parent Hono app from `web/out` on **`GET /metering/**`.

- **Dev:** `npm run dev` from this folder → open `http://localhost:3000/metering`
- **Prod:** `npm run build` from repo root (`npm run build:web`) — assets must exist before `node dist/index.js`

Do not commit `out/` or `.next/` (see root `.gitignore`).
