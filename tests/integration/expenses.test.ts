import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { expenses } from "../../src/db/schema";
import { addDays, todayBusinessDate } from "../../src/lib/time";
import { call, createTestApp, getTestDb, loginAsAdmin, resetDb, seedAdmin, type TestApp } from "../helpers";

let app: TestApp;
let token: string;
let cats: Record<string, string>;

beforeEach(async () => {
  await resetDb();
  await seedAdmin();
  app = await createTestApp();
  ({ token } = await loginAsAdmin(app));
  const list = await call(app, "GET", "/api/v1/expense-categories", { token });
  cats = Object.fromEntries(list.body.map((c: { name: string; id: string }) => [c.name, c.id]));
});

const newExpense = (body: Record<string, unknown>) =>
  call(app, "POST", "/api/v1/expenses", {
    token,
    body: { categoryId: cats["Minyak Goreng"], amount: 50000, paymentMethod: "CASH", description: "Minyak 2L", ...body },
  });

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 1, 2, 3]);

function form(bytes: Uint8Array, name: string, type: string) {
  const f = new FormData();
  f.append("file", new File([bytes], name, { type }));
  return f;
}

describe("expense categories", () => {
  test("11 defaults seeded; duplicate → 409; deactivate; in-use delete → 409", async () => {
    expect(Object.keys(cats).length).toBe(11);
    expect((await call(app, "POST", "/api/v1/expense-categories", { token, body: { name: "gas/lpg" } })).status).toBe(409);
    const created = await call(app, "POST", "/api/v1/expense-categories", { token, body: { name: "Promosi" } });
    expect(created.status).toBe(201);
    const off = await call(app, "PATCH", `/api/v1/expense-categories/${cats["Kemasan"]}`, { token, body: { isActive: false } });
    expect(off.body.isActive).toBe(false);
    const active = await call(app, "GET", "/api/v1/expense-categories?isActive=true", { token });
    expect(active.body.length).toBe(11); // 11 + Promosi − Kemasan
    const e = await newExpense({});
    await call(app, "DELETE", `/api/v1/expenses/${e.body.id}`, { token });
    const del = await call(app, "DELETE", `/api/v1/expense-categories/${cats["Minyak Goreng"]}`, { token });
    expect(del.status).toBe(409);
    expect((await call(app, "DELETE", `/api/v1/expense-categories/${created.body.id}`, { token })).status).toBe(204);
  });
});

describe("expenses", () => {
  test("create defaults to today (WIB) and returns category", async () => {
    const res = await newExpense({ vendor: "Toko Sembako" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      expenseDate: todayBusinessDate(),
      amount: 50000,
      category: { name: "Minyak Goreng" },
      vendor: "Toko Sembako",
      attachment: null,
    });
  });

  test("validation: future date, inactive category, zero amount", async () => {
    const future = await newExpense({ expenseDate: addDays(todayBusinessDate(), 1) });
    expect(future.body.error.code).toBe("EXPENSE_DATE_IN_FUTURE");
    await call(app, "PATCH", `/api/v1/expense-categories/${cats["Kemasan"]}`, { token, body: { isActive: false } });
    expect((await newExpense({ categoryId: cats["Kemasan"] })).body.error.code).toBe("CATEGORY_INACTIVE");
    expect((await newExpense({ amount: 0 })).status).toBe(422);
  });

  test("list filters, search and totalAmount", async () => {
    await newExpense({ expenseDate: "2026-09-01", amount: 100000, description: "Ayam 5kg", categoryId: cats["Bahan Baku Ayam"], vendor: "Pak Slamet" });
    await newExpense({ expenseDate: "2026-09-02", amount: 25000, description: "Gas 3kg", categoryId: cats["Gas/LPG"], paymentMethod: "QRIS" });
    await newExpense({ expenseDate: "2026-09-03", amount: 40000, description: "Ayam 2kg", categoryId: cats["Bahan Baku Ayam"] });
    const all = await call(app, "GET", "/api/v1/expenses?from=2026-09-01&to=2026-09-03", { token });
    expect(all.body.meta).toMatchObject({ total: 3, totalAmount: 165000 });
    expect(all.body.data.map((e: { expenseDate: string }) => e.expenseDate)).toEqual(["2026-09-03", "2026-09-02", "2026-09-01"]);
    const ayam = await call(app, "GET", `/api/v1/expenses?categoryId=${cats["Bahan Baku Ayam"]}`, { token });
    expect(ayam.body.meta.totalAmount).toBe(140000);
    const qris = await call(app, "GET", "/api/v1/expenses?paymentMethod=QRIS", { token });
    expect(qris.body.meta.total).toBe(1);
    const vendor = await call(app, "GET", "/api/v1/expenses?q=slamet", { token });
    expect(vendor.body.meta.totalAmount).toBe(100000);
    const page = await call(app, "GET", "/api/v1/expenses?limit=1", { token });
    expect(page.body.meta).toMatchObject({ total: 3, totalPages: 3, totalAmount: 165000 });
  });

  test("update and soft-delete", async () => {
    const e = await newExpense({});
    const upd = await call(app, "PATCH", `/api/v1/expenses/${e.body.id}`, { token, body: { amount: 60000 } });
    expect(upd.body.amount).toBe(60000);
    expect((await call(app, "DELETE", `/api/v1/expenses/${e.body.id}`, { token })).status).toBe(204);
    expect((await call(app, "GET", `/api/v1/expenses/${e.body.id}`, { token })).status).toBe(404);
    expect((await call(app, "GET", "/api/v1/expenses", { token })).body.meta.total).toBe(0);
    expect((await call(app, "DELETE", `/api/v1/expenses/${e.body.id}`, { token })).status).toBe(404);
    const { db } = await getTestDb();
    const [row] = await db.select().from(expenses).where(eq(expenses.id, e.body.id));
    expect(row.deletedAt).toBeInstanceOf(Date);
  });

  test("attachment: upload PNG, download with token (identical bytes), delete", async () => {
    const e = await newExpense({});
    const up = await call(app, "PUT", `/api/v1/expenses/${e.body.id}/attachment`, { token, form: form(PNG, "nota.png", "image/png") });
    expect(up.status).toBe(200);
    expect(up.body.attachment).toEqual({ mimeType: "image/png", size: PNG.length });
    const res = await app.handle(
      new Request(`http://localhost/api/v1/expenses/${e.body.id}/attachment`, { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect((await call(app, "GET", `/api/v1/expenses/${e.body.id}/attachment`)).status).toBe(401);
    expect((await call(app, "DELETE", `/api/v1/expenses/${e.body.id}/attachment`, { token })).status).toBe(204);
    expect((await call(app, "GET", `/api/v1/expenses/${e.body.id}/attachment`, { token })).status).toBe(404);
  });

  test("attachment: executable renamed to .png and >5 MB are rejected", async () => {
    const e = await newExpense({});
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0, 0, 0]);
    const bad = await call(app, "PUT", `/api/v1/expenses/${e.body.id}/attachment`, { token, form: form(exe, "virus.png", "image/png") });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("UNSUPPORTED_FILE_TYPE");
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(PNG);
    const huge = await call(app, "PUT", `/api/v1/expenses/${e.body.id}/attachment`, { token, form: form(big, "big.png", "image/png") });
    expect(huge.status).toBe(422);
    expect(huge.body.error.code).toBe("FILE_TOO_LARGE");
  });
});
