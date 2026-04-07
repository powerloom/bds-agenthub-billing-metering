import { Hono } from "hono";
import type { AppConfig } from "./config.js";
import { createCreditsRoutes } from "./routes/credits.js";
import { createInternalBillingRoutes } from "./routes/internal-billing.js";
import { createSignupRoutes } from "./routes/signup.js";
import { createVerifyRoutes } from "./routes/verify.js";
import type { SqliteDb } from "./types.js";

export function createApp(db: SqliteDb, config: AppConfig) {
  const app = new Hono();
  app.get("/health", (c) =>
    c.json({ ok: true, service: "bds-agenthub-billing-metering", version: "0.1.0" }),
  );
  app.route("/", createSignupRoutes(db, config));
  app.route("/", createVerifyRoutes(db, config));
  app.route("/", createCreditsRoutes(db, config));
  app.route("/", createInternalBillingRoutes(db, config));
  return app;
}
