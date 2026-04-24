import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { AppConfig } from "./config.js";
import { createCreditsRoutes } from "./routes/credits.js";
import { createInternalBillingRoutes } from "./routes/internal-billing.js";
import { createSignupPayRoutes } from "./routes/signup-pay.js";
import { createSignupRoutes } from "./routes/signup.js";
import { createVerifyRoutes } from "./routes/verify.js";
import type { SqliteDb } from "./types.js";

/** Map /metering/... to Next static export paths under web/out (flat HTML + /_next). */
function rewriteMeteringStaticPath(path: string): string {
  if (!path.startsWith("/metering")) return path;
  let rest = path.slice("/metering".length);
  if (rest === "" || rest === "/") return "/index.html";
  if (rest.includes(".") || rest.startsWith("/_next")) return rest;
  return `${rest}.html`;
}

export function createApp(db: SqliteDb, config: AppConfig) {
  const app = new Hono();
  app.get("/health", (c) =>
    c.json({ ok: true, service: "bds-agenthub-billing-metering", version: "0.1.0" }),
  );
  // Static UI from `web/` (Next export → web/out). Run `npm run build:web` before deploy.
  const meteringStatic = serveStatic({
    root: "./web/out",
    rewriteRequestPath: (p) => rewriteMeteringStaticPath(p),
  });
  app.use("/metering", meteringStatic);
  app.use("/metering/*", meteringStatic);
  app.route("/", createSignupRoutes(db, config));
  app.route("/", createSignupPayRoutes(db, config));
  app.route("/", createVerifyRoutes(db, config));
  app.route("/", createCreditsRoutes(db, config));
  app.route("/", createInternalBillingRoutes(db, config));
  return app;
}
