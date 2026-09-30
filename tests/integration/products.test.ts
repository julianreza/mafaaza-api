import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditLogs } from "../../src/db/schema";
import { call, createTestApp, getTestDb, loginAsAdmin, resetDb, seedAdmin, type TestApp } from "../helpers";

let app: TestApp;
let token: string;

beforeEach(async () => {
  await resetDb();
  await seedAdmin();
  app = await createTestApp();
  ({ token } = await loginAsAdmin(app));
});

const post = (path: string, body: unknown) => call(app, "POST", path, { token, body });

describe("product categories", () => {
  test("create, list sorted, rename, duplicate name (case-insensitive) → 409", async () => {
    const b = await post("/api/v1/product-categories", { name: "Minuman", sortOrder: 2 });
    const a = await post("/api/v1/product-categories", { name: "Ayam", sortOrder: 1 });
    expect(a.status).toBe(201);
    const list = await call(app, "GET", "/api/v1/product-categories", { token });
    expect(list.body.map((c: { name: string }) => c.name)).toEqual(["Ayam", "Minuman"]);
    const dup = await post("/api/v1/product-categories", { name: "  ayam " });
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toBe("Nama kategori produk sudah dipakai");
    const ren = await call(app, "PATCH", `/api/v1/product-categories/${b.body.id}`, { token, body: { name: "Minuman Dingin" } });
    expect(ren.body.name).toBe("Minuman Dingin");
  });

  test("delete in-use category → 409, unused → 204", async () => {
    const cat = await post("/api/v1/product-categories", { name: "Ayam" });
    const empty = await post("/api/v1/product-categories", { name: "Kosong" });
    await post("/api/v1/products", { categoryId: cat.body.id, name: "Paha Atas", price: 13000 });
    const inUse = await call(app, "DELETE", `/api/v1/product-categories/${cat.body.id}`, { token });
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.code).toBe("CATEGORY_IN_USE");
    expect((await call(app, "DELETE", `/api/v1/product-categories/${empty.body.id}`, { token })).status).toBe(204);
    expect((await call(app, "DELETE", `/api/v1/product-categories/${empty.body.id}`, { token })).status).toBe(404);
  });
});

describe("products", () => {
  let catId: string;
  beforeEach(async () => {
    catId = (await post("/api/v1/product-categories", { name: "Ayam" })).body.id;
  });

  test("create returns the product with its category", async () => {
    const res = await post("/api/v1/products", { categoryId: catId, name: "Paha Atas", price: 13000, sku: "AYM-PA" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "Paha Atas", price: 13000, sku: "AYM-PA", isActive: true, category: { id: catId, name: "Ayam" } });
  });

  test("validation: negative price and unknown category", async () => {
    expect((await post("/api/v1/products", { categoryId: catId, name: "X", price: -1 })).status).toBe(422);
    const unknown = await post("/api/v1/products", { categoryId: crypto.randomUUID(), name: "X", price: 1 });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe("CATEGORY_NOT_FOUND");
  });

  test("duplicate SKU → 409; many products without SKU are fine", async () => {
    await post("/api/v1/products", { categoryId: catId, name: "A", price: 1, sku: "SKU-1" });
    const dup = await post("/api/v1/products", { categoryId: catId, name: "B", price: 1, sku: "sku-1" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toBe("SKU sudah dipakai");
    expect((await post("/api/v1/products", { categoryId: catId, name: "C", price: 1 })).status).toBe(201);
    expect((await post("/api/v1/products", { categoryId: catId, name: "D", price: 1, sku: "" })).status).toBe(201);
  });

  test("filters, search (wildcards literal) and pagination", async () => {
    const minuman = (await post("/api/v1/product-categories", { name: "Minuman" })).body.id;
    await post("/api/v1/products", { categoryId: catId, name: "Paha Atas", price: 13000 });
    await post("/api/v1/products", { categoryId: catId, name: "Dada 100%", price: 14000 });
    const off = await post("/api/v1/products", { categoryId: catId, name: "Sayap", price: 9000 });
    await call(app, "PATCH", `/api/v1/products/${off.body.id}`, { token, body: { isActive: false } });
    await post("/api/v1/products", { categoryId: minuman, name: "Es Teh", price: 5000, sku: "MNM-TEH" });

    const all = await call(app, "GET", "/api/v1/products?limit=2&page=2", { token });
    expect(all.body.meta).toEqual({ page: 2, limit: 2, total: 4, totalPages: 2 });
    const active = await call(app, "GET", `/api/v1/products?isActive=true&categoryId=${catId}`, { token });
    expect(active.body.data.map((p: { name: string }) => p.name).sort()).toEqual(["Dada 100%", "Paha Atas"]);
    const bySku = await call(app, "GET", "/api/v1/products?q=mnm", { token });
    expect(bySku.body.data.map((p: { name: string }) => p.name)).toEqual(["Es Teh"]);
    const pct = await call(app, "GET", "/api/v1/products?q=%25", { token });
    expect(pct.body.data.map((p: { name: string }) => p.name)).toEqual(["Dada 100%"]);
  });

  test("price change is audited with before/after; delete unsold → 204", async () => {
    const p = await post("/api/v1/products", { categoryId: catId, name: "Paha Atas", price: 13000 });
    const upd = await call(app, "PATCH", `/api/v1/products/${p.body.id}`, { token, body: { price: 15000 } });
    expect(upd.body.price).toBe(15000);
    const { db } = await getTestDb();
    const [log] = await db.select().from(auditLogs).where(eq(auditLogs.action, "product.updated"));
    expect((log.before as { price: number }).price).toBe(13000);
    expect((log.after as { price: number }).price).toBe(15000);
    expect((await call(app, "DELETE", `/api/v1/products/${p.body.id}`, { token })).status).toBe(204);
    expect((await call(app, "GET", `/api/v1/products/${p.body.id}`, { token })).status).toBe(404);
  });
});
