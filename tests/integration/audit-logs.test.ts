import { beforeAll, describe, expect, test } from "bun:test";
import { auditLogs } from "../../src/db/schema";
import { todayBusinessDate } from "../../src/lib/time";
import { ADMIN, call, createMenu, createSale, createTestApp, getTestDb, loginAsAdmin, resetDb, seedAdmin, type TestApp } from "../helpers";

let app: TestApp;
let token: string;
let refreshToken: string;
let productId: string;
let saleId: string;
let expenseId: string;

beforeAll(async () => {
  await resetDb();
  await seedAdmin();
  app = await createTestApp();
  await call(app, "POST", "/api/v1/auth/login", {
    body: { email: ADMIN.email, password: "salah-sekali" },
    headers: { "x-forwarded-for": "203.0.113.9", "user-agent": "audit-test" },
  });
  ({ token, refreshToken } = await loginAsAdmin(app));
  productId = (await createMenu(app, token, { "Paha Atas": { price: 13000 } }))["Paha Atas"];
  await call(app, "PATCH", `/api/v1/products/${productId}`, { token, body: { price: 15000 } });
  saleId = (await createSale(app, token, { items: [{ productId, qty: 1 }], paymentMethod: "QRIS" })).id;
  await call(app, "POST", `/api/v1/sales/${saleId}/void`, { token, body: { reason: "Salah input" } });
  const cats = (await call(app, "GET", "/api/v1/expense-categories", { token })).body as { id: string }[];
  const e = await call(app, "POST", "/api/v1/expenses", {
    token,
    body: { categoryId: cats[0].id, amount: 10000, paymentMethod: "CASH", description: "Beli gas" },
  });
  expenseId = e.body.id;
  await call(app, "PATCH", `/api/v1/expenses/${expenseId}`, { token, body: { amount: 12000 } });
  await call(app, "DELETE", `/api/v1/expenses/${expenseId}`, { token });
});

const list = (qs = "") => call(app, "GET", `/api/v1/audit-logs${qs}`, { token });

describe("audit logs", () => {
  test("main actions are recorded newest first", async () => {
    const r = await list("?limit=100");
    const actions = r.body.data.map((d: { action: string }) => d.action).reverse();
    expect(actions).toEqual([
      "auth.login_failed",
      "auth.login_success",
      "product_category.created",
      "product.created",
      "product.updated",
      "sale.created",
      "sale.voided",
      "expense.created",
      "expense.updated",
      "expense.deleted",
    ]);
  });

  test("before/after, ip and user agent are captured", async () => {
    const r = await list(`?entityType=expense&entityId=${expenseId}&action=expense.updated`);
    expect(r.body.meta.total).toBe(1);
    const e = r.body.data[0];
    expect(e.before.amount).toBe(10000);
    expect(e.after.amount).toBe(12000);
    const failed = (await list("?action=auth.login_failed")).body.data[0];
    expect(failed.ip).toBe("203.0.113.9");
    expect(failed.userAgent).toBe("audit-test");
    expect(failed.after).toEqual({ email: ADMIN.email });
  });

  test("no secret ever lands in the table", async () => {
    const { db } = await getTestDb();
    const dump = JSON.stringify(await db.select().from(auditLogs));
    for (const secret of [ADMIN.password, "salah-sekali", token, refreshToken]) expect(dump).not.toContain(secret);
    expect(dump).not.toMatch(/passwordHash|password_hash|\$argon2/);
  });

  test("date filter (WIB) and pagination", async () => {
    const today = todayBusinessDate();
    expect((await list(`?from=${today}&to=${today}`)).body.meta.total).toBe(10);
    expect((await list("?from=2020-01-01&to=2020-01-02")).body.meta.total).toBe(0);
    const p = await list("?limit=3&page=2");
    expect(p.body.meta).toEqual({ page: 2, limit: 3, total: 10, totalPages: 4 });
  });

  test("read-only API", async () => {
    expect((await call(app, "DELETE", "/api/v1/audit-logs/1", { token })).status).toBe(404);
    expect((await call(app, "POST", "/api/v1/audit-logs", { token, body: {} })).status).toBe(404);
  });
});
