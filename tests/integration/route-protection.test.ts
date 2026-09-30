import { beforeAll, describe, expect, test } from "bun:test";
import { call, createTestApp, resetDb, type TestApp } from "../helpers";

const PUBLIC = new Set(["POST /api/v1/auth/login", "POST /api/v1/auth/refresh"]);

let app: TestApp;

beforeAll(async () => {
  await resetDb();
  app = await createTestApp();
});

describe("every /api/v1 route requires a token", () => {
  test("unauthenticated calls return 401", async () => {
    const routes = app.routes.filter((r) => r.path.startsWith("/api/v1/") && !PUBLIC.has(`${r.method} ${r.path}`));
    expect(routes.length).toBeGreaterThan(0);
    const failures: string[] = [];
    for (const r of routes) {
      const path = r.path.replace(/:[A-Za-z]+/g, "00000000-0000-4000-8000-000000000000");
      const res = await call(app, r.method, path, ["GET", "DELETE"].includes(r.method) ? {} : { body: {} });
      if (res.status !== 401) failures.push(`${r.method} ${r.path} → ${res.status}`);
    }
    expect(failures).toEqual([]);
  });

  test("login and refresh stay public", async () => {
    for (const key of PUBLIC) {
      const [method, path] = key.split(" ");
      const res = await call(app, method, path, { body: {} });
      expect(res.status).toBe(422);
    }
  });
});
