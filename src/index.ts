import { mkdir } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createApp } from "./app";
import { loadEnv } from "./config/env";
import { createDatabase, redactDbUrl } from "./db/client";
import { logger } from "./lib/logger";

const env = loadEnv();
const database = createDatabase(env.DATABASE_URL, { prepare: env.DATABASE_PREPARE });

try {
  await database.db.execute(sql`SELECT 1`);
} catch (e) {
  logger.error("tidak dapat terhubung ke database", {
    error: redactDbUrl(e instanceof Error ? e.message : String(e)),
  });
  process.exit(1);
}

await mkdir(env.UPLOAD_DIR, { recursive: true });

const app = createApp({ db: database.db, env }).listen({ port: env.PORT, hostname: env.HOST });
logger.info("server started", { host: env.HOST, port: env.PORT, env: env.NODE_ENV, openapi: env.OPENAPI_ENABLED });

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info("shutting down", { signal });
  await app.stop();
  await database.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
