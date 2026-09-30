import { beforeAll, describe, expect, test } from "bun:test";
import { ExportService } from "../../src/modules/exports/service";
import { call, createMenu, createSale, createTestApp, getTestDb, loginAsAdmin, resetDb, seedAdmin, type TestApp } from "../helpers";

let app: TestApp;
let token: string;

async function csv(path: string) {
  const res = await app.handle(new Request(`http://localhost/api/v1/exports/${path}`, { headers: { authorization: `Bearer ${token}` } }));
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  return { res, bytes, text, lines: text.replace(/^\uFEFF/, "").trimEnd().split("\r\n") };
}

beforeAll(async () => {
  await resetDb();
  await seedAdmin();
  app = await createTestApp();
  ({ token } = await loginAsAdmin(app));
  const menu = await createMenu(app, token, { "Paha Atas": { price: 13000 }, "Es Teh": { price: 5000, category: "Minuman" } });
  await createSale(app, token, {
    soldAt: "2026-09-01T17:30:05Z", // 2 Sep 00:30:05 WIB
    paymentMethod: "CASH",
    cashReceived: 20000,
    note: 'pedas, "extra"',
    items: [
      { productId: menu["Paha Atas"], qty: 1 },
      { productId: menu["Es Teh"], qty: 1 },
    ],
  });
  const v = await createSale(app, token, { soldAt: "2026-09-02T05:00:00Z", paymentMethod: "QRIS", items: [{ productId: menu["Es Teh"], qty: 2 }] });
  await call(app, "POST", `/api/v1/sales/${v.id}/void`, { token, body: { reason: "Batal" } });
  await createSale(app, token, { soldAt: "2026-09-05T05:00:00Z", paymentMethod: "QRIS", items: [{ productId: menu["Es Teh"], qty: 1 }] });

  const cats = (await call(app, "GET", "/api/v1/expense-categories", { token })).body as { id: string; name: string }[];
  const cat = cats.find((c) => c.name === "Lain-lain")!.id;
  await call(app, "POST", "/api/v1/expenses", {
    token,
    body: { expenseDate: "2026-09-02", categoryId: cat, amount: 15000, paymentMethod: "CASH", description: "=SUM(A1)" },
  });
  const del = await call(app, "POST", "/api/v1/expenses", {
    token,
    body: { expenseDate: "2026-09-02", categoryId: cat, amount: 1000, paymentMethod: "CASH", description: "dihapus" },
  });
  await call(app, "DELETE", `/api/v1/expenses/${del.body.id}`, { token });
});

describe("CSV exports", () => {
  test("sales.csv: headers, BOM, WIB time, voided included, escaping", async () => {
    const { res, bytes, lines } = await csv("sales.csv?from=2026-09-01&to=2026-09-03");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="sales_2026-09-01_2026-09-03.csv"');
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(lines[0]).toBe(
      "receipt_no,business_date,sold_at_wib,order_type,payment_method,subtotal,discount,total,cash_received,change_amount,status,void_reason,note",
    );
    expect(lines.length).toBe(3);
    expect(lines[1]).toBe('INV-20260902-0001,2026-09-02,2026-09-02 00:30:05,TAKE_AWAY,CASH,18000,0,18000,20000,2000,COMPLETED,,"pedas, ""extra"""');
    expect(lines[2]).toContain(",VOIDED,Batal,");
  });

  test("sale-items.csv: one row per item", async () => {
    const { lines } = await csv("sale-items.csv?from=2026-09-01&to=2026-09-03");
    expect(lines[0]).toBe("receipt_no,business_date,product_name,category_name,unit_price,qty,line_total,sale_status");
    expect(lines.slice(1)).toEqual([
      "INV-20260902-0001,2026-09-02,Paha Atas,Ayam,13000,1,13000,COMPLETED",
      "INV-20260902-0001,2026-09-02,Es Teh,Minuman,5000,1,5000,COMPLETED",
      "INV-20260902-0002,2026-09-02,Es Teh,Minuman,5000,2,10000,VOIDED",
    ]);
  });

  test("expenses.csv: deleted excluded, formula neutralised", async () => {
    const { lines } = await csv("expenses.csv?from=2026-09-01&to=2026-09-03");
    expect(lines).toEqual([
      "expense_date,category,description,vendor,payment_method,amount,has_attachment",
      "2026-09-02,Lain-lain,'=SUM(A1),,CASH,15000,false",
    ]);
  });

  test("keyset pagination returns every row across batches", async () => {
    const { db } = await getTestDb();
    const svc = new ExportService(db, 1);
    const rows: unknown[][] = [];
    for await (const batch of svc.sales({ from: "2026-09-01", to: "2026-09-30" })) rows.push(...batch);
    expect(rows.map((r) => r[0])).toEqual(["INV-20260902-0001", "INV-20260902-0002", "INV-20260905-0001"]);
    const items: unknown[][] = [];
    for await (const batch of svc.saleItems({ from: "2026-09-01", to: "2026-09-30" })) items.push(...batch);
    expect(items.length).toBe(4);
  });

  test("range validation and auth", async () => {
    expect((await csv("sales.csv?from=2025-01-01&to=2026-09-01")).res.status).toBe(422);
    expect((await call(app, "GET", "/api/v1/exports/sales.csv")).status).toBe(401);
  });
});
