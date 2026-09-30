// Manual performance check (R9.6): `bun run test:perf` against the test database.
import { beforeAll, describe, expect, test } from "bun:test";
import { count } from "drizzle-orm";
import { sales } from "../../src/db/schema";
import { call, createMenu, createTestApp, getTestDb, loginAsAdmin, resetDb, seedAdmin, type TestApp } from "../helpers";
import { PERF_FROM, PERF_TO, seedPerfData } from "./seed-30k";

const RUNS = 50;
let app: TestApp;
let token: string;

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

async function measure(fn: () => Promise<{ status: number }>, expected: number): Promise<number[]> {
  await fn(); // warm-up
  const out: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    const r = await fn();
    out.push(performance.now() - t0);
    expect(r.status).toBe(expected);
  }
  return out;
}

beforeAll(async () => {
  await resetDb();
  await seedAdmin();
  const { db } = await getTestDb();
  await seedPerfData(db);
  app = await createTestApp();
  ({ token } = await loginAsAdmin(app));
});

describe("performance", () => {
  test("30.000 sales seeded", async () => {
    const { db } = await getTestDb();
    const [{ n }] = await db.select({ n: count() }).from(sales);
    expect(n).toBe(30_000);
  });

  test("summary over 31 days: p95 < 1 s", async () => {
    const t = await measure(() => call(app, "GET", `/api/v1/reports/summary?from=${PERF_FROM}&to=${PERF_TO}`, { token }), 200);
    console.log(`summary p95 = ${p95(t).toFixed(1)} ms`);
    expect(p95(t)).toBeLessThan(1000);
  });

  test("sales breakdown over 31 days: p95 < 1 s", async () => {
    const t = await measure(() => call(app, "GET", `/api/v1/reports/sales-breakdown?from=${PERF_FROM}&to=${PERF_TO}`, { token }), 200);
    console.log(`sales-breakdown p95 = ${p95(t).toFixed(1)} ms`);
    expect(p95(t)).toBeLessThan(1000);
  });

  test("create sale: p95 < 300 ms", async () => {
    const menu = await createMenu(app, token, { "Perf Paha": { price: 13000 }, "Perf Teh": { price: 5000, category: "Perf Drinks" } });
    const body = {
      items: [
        { productId: menu["Perf Paha"], qty: 2 },
        { productId: menu["Perf Teh"], qty: 1 },
      ],
      paymentMethod: "CASH",
      cashReceived: 50000,
    };
    const t = await measure(() => call(app, "POST", "/api/v1/sales", { token, body }), 201);
    console.log(`create sale p95 = ${p95(t).toFixed(1)} ms`);
    expect(p95(t)).toBeLessThan(300);
  });
});
