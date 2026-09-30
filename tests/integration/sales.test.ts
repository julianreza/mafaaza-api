import { beforeEach, describe, expect, test } from "bun:test";
import { count, eq } from "drizzle-orm";
import { auditLogs, idempotencyKeys, receiptCounters, saleItems, sales } from "../../src/db/schema";
import { toBusinessDate } from "../../src/lib/time";
import { call, createMenu, createSale, createTestApp, getTestDb, loginAsAdmin, resetDb, seedAdmin, type TestApp } from "../helpers";

let app: TestApp;
let token: string;
let menu: Record<string, string>;

beforeEach(async () => {
  await resetDb();
  await seedAdmin();
  app = await createTestApp();
  ({ token } = await loginAsAdmin(app));
  menu = await createMenu(app, token, {
    "Paha Atas": { price: 13000 },
    "Es Teh": { price: 5000, category: "Minuman" },
    Sayap: { price: 9000, isActive: false },
  });
});

const postSale = (body: unknown, headers: Record<string, string> = {}) =>
  call(app, "POST", "/api/v1/sales", { token, body, headers });

const rowCounts = async () => {
  const { db } = await getTestDb();
  const [[a], [b], [c]] = await Promise.all([
    db.select({ n: count() }).from(sales),
    db.select({ n: count() }).from(saleItems),
    db.select({ n: count() }).from(receiptCounters),
  ]);
  return [a.n, b.n, c.n];
};

describe("create sale", () => {
  test("computes totals from product prices (client price ignored) and snapshots names", async () => {
    const res = await postSale({
      items: [
        { productId: menu["Paha Atas"], qty: 2, unitPrice: 1 },
        { productId: menu["Es Teh"], qty: 1 },
      ],
      paymentMethod: "CASH",
      discount: 1000,
      cashReceived: 50000,
      note: "tanpa sambal",
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      subtotal: 31000,
      discount: 1000,
      total: 30000,
      cashReceived: 50000,
      changeAmount: 20000,
      orderType: "TAKE_AWAY",
      status: "COMPLETED",
      note: "tanpa sambal",
    });
    expect(res.body.receiptNo).toBe(`INV-${toBusinessDate(new Date()).replaceAll("-", "")}-0001`);
    expect(res.body.items).toEqual([
      expect.objectContaining({ productName: "Paha Atas", categoryName: "Ayam", unitPrice: 13000, qty: 2, lineTotal: 26000 }),
      expect.objectContaining({ productName: "Es Teh", categoryName: "Minuman", unitPrice: 5000, qty: 1, lineTotal: 5000 }),
    ]);
  });

  test("price change does not alter past sales", async () => {
    const sale = await createSale(app, token, { items: [{ productId: menu["Paha Atas"], qty: 1 }], paymentMethod: "QRIS" });
    await call(app, "PATCH", `/api/v1/products/${menu["Paha Atas"]}`, { token, body: { price: 20000, name: "Paha Atas Jumbo" } });
    const again = await call(app, "GET", `/api/v1/sales/${sale.id}`, { token });
    expect(again.body.total).toBe(13000);
    expect(again.body.items[0]).toMatchObject({ productName: "Paha Atas", unitPrice: 13000 });
  });

  test("inactive or unknown product → 422 and nothing is written", async () => {
    const res = await postSale({
      items: [
        { productId: menu["Paha Atas"], qty: 1 },
        { productId: menu.Sayap, qty: 1 },
        { productId: "00000000-0000-4000-8000-000000000000", qty: 1 },
      ],
      paymentMethod: "QRIS",
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("PRODUCT_UNAVAILABLE");
    expect(res.body.error.details).toEqual([
      { productId: menu.Sayap, reason: "inactive" },
      { productId: "00000000-0000-4000-8000-000000000000", reason: "not_found" },
    ]);
    expect(await rowCounts()).toEqual([0, 0, 0]);
  });

  test("validation: discount > subtotal, short cash, cash for non-CASH, empty items, DINE_IN, future soldAt", async () => {
    const one = [{ productId: menu["Paha Atas"], qty: 1 }];
    expect((await postSale({ items: one, paymentMethod: "QRIS", discount: 13001 })).body.error.code).toBe("INVALID_DISCOUNT");
    expect((await postSale({ items: one, paymentMethod: "CASH", cashReceived: 10000 })).body.error.code).toBe("INSUFFICIENT_CASH");
    expect((await postSale({ items: one, paymentMethod: "QRIS", cashReceived: 20000 })).status).toBe(422);
    expect((await postSale({ items: [], paymentMethod: "QRIS" })).status).toBe(422);
    expect((await postSale({ items: one, paymentMethod: "QRIS", orderType: "DINE_IN" })).status).toBe(422);
    const future = await postSale({ items: one, paymentMethod: "QRIS", soldAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(future.body.error.code).toBe("SOLD_AT_IN_FUTURE");
    expect(await rowCounts()).toEqual([0, 0, 0]);
  });

  test("receipt sequence resets per WIB business day", async () => {
    const one = [{ productId: menu["Es Teh"], qty: 1 }];
    const a = await createSale(app, token, { items: one, paymentMethod: "QRIS", soldAt: "2026-09-01T16:59:00Z" }); // 1 Sep WIB
    const b = await createSale(app, token, { items: one, paymentMethod: "QRIS", soldAt: "2026-09-01T17:01:00Z" }); // 2 Sep WIB
    const c = await createSale(app, token, { items: one, paymentMethod: "QRIS", soldAt: "2026-09-02T03:00:00Z" }); // 2 Sep WIB
    expect([a.receiptNo, b.receiptNo, c.receiptNo]).toEqual(["INV-20260901-0001", "INV-20260902-0001", "INV-20260902-0002"]);
    expect(a.businessDate).toBe("2026-09-01");
  });

  test("20 concurrent sales get 20 unique consecutive numbers", async () => {
    const body = { items: [{ productId: menu["Es Teh"], qty: 1 }], paymentMethod: "QRIS", soldAt: "2026-09-10T05:00:00Z" };
    const results = await Promise.all(Array.from({ length: 20 }, () => postSale(body)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const nos = results.map((r) => r.body.receiptNo).sort();
    expect(nos).toEqual(Array.from({ length: 20 }, (_, i) => `INV-20260910-${String(i + 1).padStart(4, "0")}`));
  });

  test("idempotency: replay returns the same sale; different body → 409", async () => {
    const body = { items: [{ productId: menu["Es Teh"], qty: 2 }], paymentMethod: "QRIS" };
    const first = await postSale(body, { "idempotency-key": "kasir-1-abc" });
    const replay = await postSale(body, { "idempotency-key": "kasir-1-abc" });
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    const other = await postSale({ ...body, discount: 1000 }, { "idempotency-key": "kasir-1-abc" });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await rowCounts())[0]).toBe(1);
  });

  test("idempotency: concurrent twins create exactly one sale", async () => {
    const body = { items: [{ productId: menu["Es Teh"], qty: 1 }], paymentMethod: "QRIS" };
    const res = await Promise.all(Array.from({ length: 5 }, () => postSale(body, { "idempotency-key": "twin-key" })));
    expect(res.every((r) => r.status === 201)).toBe(true);
    expect(new Set(res.map((r) => r.body.id)).size).toBe(1);
    expect((await rowCounts())[0]).toBe(1);
  });

  test("idempotency key older than 24h is treated as new", async () => {
    const body = { items: [{ productId: menu["Es Teh"], qty: 1 }], paymentMethod: "QRIS" };
    const first = await postSale(body, { "idempotency-key": "old-key" });
    const { db } = await getTestDb();
    await db.update(idempotencyKeys).set({ createdAt: new Date(Date.now() - 25 * 3_600_000) });
    const second = await postSale(body, { "idempotency-key": "old-key" });
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
  });

  test("sold product cannot be deleted", async () => {
    await createSale(app, token, { items: [{ productId: menu["Es Teh"], qty: 1 }], paymentMethod: "QRIS" });
    const del = await call(app, "DELETE", `/api/v1/products/${menu["Es Teh"]}`, { token });
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe("PRODUCT_IN_USE");
  });
});

describe("list / detail / void", () => {
  test("filters and ordering", async () => {
    const one = [{ productId: menu["Es Teh"], qty: 1 }];
    await createSale(app, token, { items: one, paymentMethod: "QRIS", soldAt: "2026-09-01T05:00:00Z" });
    await createSale(app, token, { items: one, paymentMethod: "CASH", orderType: "ONLINE", soldAt: "2026-09-02T05:00:00Z" });
    const c = await createSale(app, token, { items: one, paymentMethod: "CASH", soldAt: "2026-09-03T05:00:00Z" });

    const all = await call(app, "GET", "/api/v1/sales", { token });
    expect(all.body.data.map((s: { receiptNo: string }) => s.receiptNo)).toEqual([
      "INV-20260903-0001",
      "INV-20260902-0001",
      "INV-20260901-0001",
    ]);
    expect(all.body.data[0].itemCount).toBe(1);
    const range = await call(app, "GET", "/api/v1/sales?from=2026-09-02&to=2026-09-03&paymentMethod=CASH&orderType=TAKE_AWAY", { token });
    expect(range.body.data.map((s: { id: string }) => s.id)).toEqual([c.id]);
    const q = await call(app, "GET", "/api/v1/sales?q=20260901", { token });
    expect(q.body.meta.total).toBe(1);
  });

  test("void: status, reason, audit, second void 409, filter by status", async () => {
    const s = await createSale(app, token, { items: [{ productId: menu["Es Teh"], qty: 1 }], paymentMethod: "QRIS" });
    expect((await call(app, "POST", `/api/v1/sales/${s.id}/void`, { token, body: { reason: "x" } })).status).toBe(422);
    const v = await call(app, "POST", `/api/v1/sales/${s.id}/void`, { token, body: { reason: "Salah input" } });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ status: "VOIDED", voidReason: "Salah input" });
    expect(v.body.voidedAt).toBeString();
    const again = await call(app, "POST", `/api/v1/sales/${s.id}/void`, { token, body: { reason: "Salah input" } });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("ALREADY_VOIDED");
    const voided = await call(app, "GET", "/api/v1/sales?status=VOIDED", { token });
    expect(voided.body.meta.total).toBe(1);
    const { db } = await getTestDb();
    const [log] = await db.select().from(auditLogs).where(eq(auditLogs.action, "sale.voided"));
    expect(log.after).toEqual({ status: "VOIDED", reason: "Salah input" });
  });

  test("sales are immutable: no PATCH/DELETE routes", async () => {
    const s = await createSale(app, token, { items: [{ productId: menu["Es Teh"], qty: 1 }], paymentMethod: "QRIS" });
    expect((await call(app, "PATCH", `/api/v1/sales/${s.id}`, { token, body: { total: 1 } })).status).toBe(404);
    expect((await call(app, "DELETE", `/api/v1/sales/${s.id}`, { token })).status).toBe(404);
    expect((await call(app, "GET", `/api/v1/sales/${crypto.randomUUID()}`, { token })).status).toBe(404);
  });
});
