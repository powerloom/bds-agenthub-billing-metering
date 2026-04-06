import { serve } from "@hono/node-server";
import { type AppConfig, loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { openDb } from "./db/client.js";

const dbPath = process.env.DB_PATH ?? "./data/signup.db";
const db = openDb(dbPath);
let config: AppConfig;
try {
  config = loadConfig();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
const app = createApp(db, config);

console.error(
  `[bds-agent-signup] listening http://127.0.0.1:${config.port} (BASE_URL=${config.baseUrl})`,
);

serve({
  fetch: app.fetch,
  port: config.port,
});
