import { beforeAll, describe, expect, test } from "bun:test";
import { call, createTestApp, resetDb, type TestApp } from "../helpers";

let app: TestApp;

beforeAll(async () => {
  await resetDb();
  app = await createTestApp();
});

describe("app skeleton", () => {
  test("GET /health returns ok", async () => {
    const res = await call(app, "GET", "/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", db: "ok" });
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("valid X-Request-Id from client is echoed", async () => {
    const res = await call(app, "GET", "/health", { headers: { "x-request-id": "abc-12345678" } });
    expect(res.headers.get("x-request-id")).toBe("abc-12345678");
  });

  test("unknown route → 404 standard envelope", async () => {
    const res = await call(app, "GET", "/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "NOT_FOUND", message: "Endpoint tidak ditemukan" } });
  });

  test("CORS: registered origin gets the header, others do not", async () => {
    const ok = await call(app, "GET", "/health", { headers: { origin: "http://localhost:5173" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const bad = await call(app, "GET", "/health", { headers: { origin: "http://evil.test" } });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("OpenAPI served when enabled", async () => {
    const res = await call(app, "GET", "/openapi/json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(res.body.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
    const ui = await call(app, "GET", "/openapi");
    expect(ui.status).toBe(200);
  });

  test("OpenAPI disabled → 404", async () => {
    const off = await createTestApp({ env: { OPENAPI_ENABLED: "false" } });
    expect((await call(off, "GET", "/openapi/json")).status).toBe(404);
    expect((await call(off, "GET", "/openapi")).status).toBe(404);
  });
});
