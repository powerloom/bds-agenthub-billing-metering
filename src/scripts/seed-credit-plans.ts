/**
 * One-off / deploy helper: insert default rows into `credit_plans` if missing.
 *
 * Usage: DB_PATH=./data/signup.db npm run seed:plans
 */
import "dotenv/config";
import { openDb } from "../db/client.js";
import { seedDefaultCreditPlans } from "../lib/seed-credit-plans.js";

const dbPath = process.env.DB_PATH ?? "./data/signup.db";
const db = openDb(dbPath);
try {
  const n = seedDefaultCreditPlans(db);
  console.error(`[seed-credit-plans] DB_PATH=${dbPath} inserted ${n} row(s) (existing ids skipped).`);
} finally {
  db.close();
}
