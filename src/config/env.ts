import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const BoolString = Type.Union([Type.Literal("true"), Type.Literal("false")]);
const IntString = Type.String({ pattern: "^[0-9]+$" });

const RawEnvSchema = Type.Object({
  NODE_ENV: Type.Optional(
    Type.Union([Type.Literal("development"), Type.Literal("test"), Type.Literal("production")]),
  ),
  PORT: Type.Optional(IntString),
  HOST: Type.Optional(Type.String({ minLength: 1 })),
  DATABASE_URL: Type.String({ pattern: "^postgres(ql)?://" }),
  JWT_SECRET: Type.String({ minLength: 32 }),
  ACCESS_TOKEN_TTL_SECONDS: Type.Optional(IntString),
  REFRESH_TOKEN_TTL_DAYS: Type.Optional(IntString),
  CORS_ORIGINS: Type.String({ minLength: 1 }),
  OPENAPI_ENABLED: Type.Optional(BoolString),
  UPLOAD_DIR: Type.Optional(Type.String({ minLength: 1 })),
  TRUST_PROXY: Type.Optional(BoolString),
});

export interface Env {
  NODE_ENV: "development" | "test" | "production";
  PORT: number;
  /** Bind address; 0.0.0.0 inside containers, 127.0.0.1 for local-only. */
  HOST: string;
  DATABASE_URL: string;
  JWT_SECRET: string;
  ACCESS_TOKEN_TTL_SECONDS: number;
  REFRESH_TOKEN_TTL_DAYS: number;
  CORS_ORIGINS: string[];
  OPENAPI_ENABLED: boolean;
  UPLOAD_DIR: string;
  TRUST_PROXY: boolean;
  /** false when connecting through a transaction-mode pooler (e.g. Supabase port 6543). */
  DATABASE_PREPARE: boolean;
  /** Session/direct connection used by `db:migrate` and drizzle-kit; falls back to DATABASE_URL. */
  DATABASE_MIGRATION_URL?: string;
}

export interface DbEnv {
  prepare: boolean;
  migrationUrl: string | undefined;
}

/** Collect DATABASE_PREPARE / DATABASE_MIGRATION_URL problems without throwing. */
function collectDbEnv(source: Record<string, string | undefined>): { value: DbEnv; issues: string[] } {
  const issues: string[] = [];
  const prepareRaw = source.DATABASE_PREPARE || undefined;
  if (prepareRaw !== undefined && prepareRaw !== "true" && prepareRaw !== "false") {
    issues.push("DATABASE_PREPARE: harus 'true' atau 'false'");
  }
  const migrationUrl = source.DATABASE_MIGRATION_URL || undefined;
  if (migrationUrl !== undefined && !/^postgres(ql)?:\/\//.test(migrationUrl)) {
    issues.push("DATABASE_MIGRATION_URL: harus diawali postgres:// atau postgresql://");
  }
  return { value: { prepare: prepareRaw !== "false", migrationUrl }, issues };
}

/**
 * Parse only the database connection settings. Independent of JWT_SECRET/CORS_ORIGINS so
 * CLI scripts (migrate, seed, reset-password) can use it. Throws EnvError on invalid values.
 */
export function parseDbEnv(source: Record<string, string | undefined>): DbEnv {
  const { value, issues } = collectDbEnv(source);
  if (issues.length > 0) throw new EnvError(issues);
  return value;
}

export class EnvError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Konfigurasi environment tidak valid:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "EnvError";
  }
}

/** Parse & validate environment variables. Throws EnvError listing every invalid variable. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const picked: Record<string, string> = {};
  for (const key of Object.keys(RawEnvSchema.properties)) {
    const v = source[key];
    if (v !== undefined && v !== "") picked[key] = v;
  }

  const db = collectDbEnv(source);

  if (!Value.Check(RawEnvSchema, picked)) {
    const issues = new Map<string, string>();
    for (const err of Value.Errors(RawEnvSchema, picked)) {
      const name = err.path.replace(/^\//, "") || "(root)";
      if (!issues.has(name)) {
        issues.set(name, picked[name] === undefined ? "wajib diisi" : err.message);
      }
    }
    throw new EnvError([...[...issues].map(([k, m]) => `${k}: ${m}`), ...db.issues]);
  }
  if (db.issues.length > 0) throw new EnvError(db.issues);

  const raw = picked as Static<typeof RawEnvSchema>;
  const origins = raw.CORS_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (origins.length === 0) throw new EnvError(["CORS_ORIGINS: minimal satu origin"]);

  return {
    NODE_ENV: raw.NODE_ENV ?? "development",
    PORT: Number(raw.PORT ?? 3000),
    HOST: raw.HOST ?? "0.0.0.0",
    DATABASE_URL: raw.DATABASE_URL,
    JWT_SECRET: raw.JWT_SECRET,
    ACCESS_TOKEN_TTL_SECONDS: Number(raw.ACCESS_TOKEN_TTL_SECONDS ?? 900),
    REFRESH_TOKEN_TTL_DAYS: Number(raw.REFRESH_TOKEN_TTL_DAYS ?? 7),
    CORS_ORIGINS: origins,
    OPENAPI_ENABLED: (raw.OPENAPI_ENABLED ?? "true") === "true",
    UPLOAD_DIR: raw.UPLOAD_DIR ?? "./storage/uploads",
    TRUST_PROXY: (raw.TRUST_PROXY ?? "false") === "true",
    DATABASE_PREPARE: db.value.prepare,
    DATABASE_MIGRATION_URL: db.value.migrationUrl,
  };
}

/** Load env from process.env; on failure print the problems and exit(1). */
export function loadEnv(): Env {
  try {
    return parseEnv(process.env);
  } catch (e) {
    if (e instanceof EnvError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}
