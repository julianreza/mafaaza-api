import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./src/db/migrations",
  // drizzle-kit needs a session connection (Supabase port 5432), not the transaction pooler.
  dbCredentials: {
    url:
      process.env.DATABASE_MIGRATION_URL ??
      process.env.DATABASE_URL ??
      "postgres://mafaaza:mafaaza@localhost:5432/mafaaza",
  },
  strict: true,
  verbose: true,
});
