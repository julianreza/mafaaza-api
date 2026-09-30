import { beforeAll, describe, expect, test } from "bun:test";
import { call, createTestApp, loginAsAdmin, resetDb, seedAdmin, type TestApp } from "../helpers";

type Op = { security?: unknown[]; responses?: Record<string, { content?: Record<string, { schema?: any }> }>; tags?: string[] };

let spec: { paths: Record<string, Record<string, Op>> };
let app: TestApp;

const PUBLIC = new Set(["post /api/v1/auth/login", "post /api/v1/auth/refresh"]);

beforeAll(async () => {
  await resetDb();
  app = await createTestApp();
  spec = (await call(app, "GET", "/openapi/json")).body;
});

const ops = () =>
  Object.entries(spec.paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, op]) => ({ path, method, op })));

describe("OpenAPI contract", () => {
  test("every business route is documented", () => {
    const documented = new Set(ops().map((o) => `${o.method.toUpperCase()} ${o.path.replace(/\{(\w+)\}/g, ":$1")}`));
    const missing = app.routes
      .filter((r) => r.path.startsWith("/api/v1"))
      .map((r) => `${r.method} ${r.path}`)
      .filter((k) => !documented.has(k));
    expect(missing).toEqual([]);
    expect(documented.has("GET /api/v1/exports/sales.csv")).toBe(true);
  });

  test("protected operations declare bearer security, public ones do not", () => {
    for (const { path, method, op } of ops().filter((o) => o.path.startsWith("/api/v1/"))) {
      const key = `${method} ${path}`;
      if (PUBLIC.has(key)) expect(op.security ?? [], key).toEqual([]);
      else expect(op.security, key).toEqual([{ bearerAuth: [] }]);
    }
  });

  test("each operation has a tag, a 2xx response and error responses", () => {
    for (const { path, method, op } of ops()) {
      const codes = Object.keys(op.responses ?? {});
      const key = `${method} ${path}`;
      expect(op.tags?.length, key).toBeGreaterThan(0);
      expect(codes.some((c) => c.startsWith("2")), key).toBe(true);
      if (path.startsWith("/api/v1/")) expect(codes, key).toContain("401");
    }
  });

  test("list endpoints use the { data, meta } envelope", () => {
    const lists = ["/api/v1/products", "/api/v1/sales", "/api/v1/expenses", "/api/v1/audit-logs"];
    for (const p of lists) {
      const schema = spec.paths[p]?.get?.responses?.["200"]?.content?.["application/json"]?.schema;
      expect(schema?.properties?.data?.type, p).toBe("array");
      expect(Object.keys(schema?.properties?.meta?.properties ?? {}), p).toEqual(
        expect.arrayContaining(["page", "limit", "total", "totalPages"]),
      );
    }
  });

  test("collection routes answer without a trailing slash", async () => {
    await seedAdmin();
    const { token } = await loginAsAdmin(app);
    expect((await call(app, "GET", "/api/v1/products", { token })).status).toBe(200);
    expect((await call(app, "GET", "/api/v1/products/", { token })).status).toBe(200);
  });
});
