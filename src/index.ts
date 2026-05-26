import "dotenv/config";
import { serve } from "@hono/node-server";
import { type AppConfig, loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { openDb } from "./db/client.js";
import { syncRateLimitDefaultsFromConfig } from "./db/migrate.js";

const dbPath = process.env.DB_PATH ?? "./data/signup.db";
let config: AppConfig;
try {
  config = loadConfig();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
const db = openDb(dbPath);
const syncedKeys = syncRateLimitDefaultsFromConfig(db, config);
if (syncedKeys > 0) {
  console.error(
    `[bds-agenthub-billing-metering] synced rate limits on ${syncedKeys} api key(s) to ${config.defaultRateLimitRpm}/min, ${config.defaultRateLimitRpd}/day`,
  );
}
const app = createApp(db, config);

console.error(
  `[bds-agenthub-billing-metering] listening http://127.0.0.1:${config.port} (BASE_URL=${config.baseUrl})`,
);

serve({
  fetch: app.fetch,
  port: config.port,
});
