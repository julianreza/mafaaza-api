import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";

export const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));

/** Apply all pending migrations to `url`. */
export async function runMigrations(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  const { EnvError, parseDbEnv } = await import("../config/env");
  let url: string | undefined;
  try {
    // Session/direct connection preferred: transaction poolers drop session state migrations rely on.
    url = parseDbEnv(process.env).migrationUrl ?? process.env.DATABASE_URL;
  } catch (e) {
    if (e instanceof EnvError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
  if (!url) {
    console.error("DATABASE_URL wajib diisi");
    process.exit(1);
  }
  await runMigrations(url);
  console.log("Migrasi selesai");
}
