import { sql } from "drizzle-orm";
import { createApp, type AppDeps } from "../src/app";
import { parseEnv, type Env } from "../src/config/env";
import { createDatabase, type Database } from "../src/db/client";
import { runMigrations } from "../src/db/migrate";
import { seed } from "../src/db/seed";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL!;

let database: Database | undefined;
let migrated: Promise<void> | undefined;

/** Shared test database (migrated once per process). */
export async function getTestDb(): Promise<Database> {
  migrated ??= runMigrations(TEST_DATABASE_URL);
  await migrated;
  database ??= createDatabase(TEST_DATABASE_URL, { max: 5 });
  return database;
}

const TABLES = [
  "audit_logs",
  "idempotency_keys",
  "sale_items",
  "sales",
  "receipt_counters",
  "products",
  "product_categories",
  "expenses",
  "expense_categories",
  "refresh_tokens",
  "admins",
];

export async function resetDb(): Promise<void> {
  const { db } = await getTestDb();
  await db.execute(sql.raw(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`));
}

export function testEnv(overrides: Record<string, string> = {}): Env {
  return parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: TEST_DATABASE_URL,
    JWT_SECRET: process.env.JWT_SECRET,
    CORS_ORIGINS: "http://localhost:5173",
    UPLOAD_DIR: process.env.TEST_UPLOAD_DIR ?? `${process.env.TMPDIR ?? "/tmp"}/mafaaza-test-uploads`,
    TRUST_PROXY: "true",
    ...overrides,
  });
}

export async function createTestApp(opts: { env?: Record<string, string>; now?: () => Date } = {}) {
  const { db } = await getTestDb();
  const deps: AppDeps = { db, env: testEnv(opts.env), now: opts.now };
  return createApp(deps);
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;

export const ADMIN = { email: "admin@toko.test", password: "rahasia-123", name: "Admin Toko" };

/** Seed the admin + default expense categories. */
export async function seedAdmin(): Promise<void> {
  const { db } = await getTestDb();
  await seed(db, ADMIN);
}

let ipCounter = 0;
/** A fresh fake client IP per call, so rate limiting never leaks between tests. */
export function nextIp(): string {
  ipCounter++;
  return `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

export async function loginAsAdmin(app: TestApp): Promise<{ token: string; refreshToken: string }> {
  const res = await call(app, "POST", "/api/v1/auth/login", {
    body: { email: ADMIN.email, password: ADMIN.password },
    headers: { "x-forwarded-for": nextIp() },
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.text}`);
  return { token: res.body.accessToken, refreshToken: res.body.refreshToken };
}

export interface TestResponse<T = any> {
  status: number;
  headers: Headers;
  body: T;
  text: string;
}

export async function call<T = any>(
  app: TestApp,
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; headers?: Record<string, string>; form?: FormData } = {},
): Promise<TestResponse<T>> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: RequestInit["body"];
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers["content-type"] ??= "application/json";
    body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await app.handle(new Request(`http://localhost${path}`, { method, headers, body }));
  const text = await res.text();
  let parsed: unknown = text;
  if ((res.headers.get("content-type") ?? "").includes("json") && text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, headers: res.headers, body: parsed as T, text };
}

/** Create a product category + products through the API; returns ids keyed by name. */
export async function createMenu(
  app: TestApp,
  token: string,
  menu: Record<string, { price: number; category?: string; isActive?: boolean }>,
): Promise<Record<string, string>> {
  const cats = new Map<string, string>();
  const ids: Record<string, string> = {};
  for (const [name, spec] of Object.entries(menu)) {
    const catName = spec.category ?? "Ayam";
    if (!cats.has(catName)) {
      const c = await call(app, "POST", "/api/v1/product-categories", { token, body: { name: catName } });
      if (c.status !== 201) throw new Error(`category: ${c.text}`);
      cats.set(catName, c.body.id);
    }
    const p = await call(app, "POST", "/api/v1/products", {
      token,
      body: { categoryId: cats.get(catName), name, price: spec.price, isActive: spec.isActive ?? true },
    });
    if (p.status !== 201) throw new Error(`product: ${p.text}`);
    ids[name] = p.body.id;
  }
  return ids;
}

export async function createSale(app: TestApp, token: string, body: Record<string, unknown>) {
  const res = await call(app, "POST", "/api/v1/sales", { token, body });
  if (res.status !== 201) throw new Error(`sale: ${res.status} ${res.text}`);
  return res.body;
}
