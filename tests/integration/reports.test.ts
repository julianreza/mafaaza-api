import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { call, createMenu, createSale, createTestApp, getTestDb, loginAsAdmin, resetDb, seedAdmin, type TestApp } from "../helpers";

let app: TestApp;
let token: string;
let menu: Record<string, string>;
let cats: Record<string, string>;

const get = (path: string) => call(app, "GET", `/api/v1/reports${path}`, { token });

beforeAll(async () => {
  await resetDb();
  await seedAdmin();
  app = await createTestApp();
  ({ token } = await loginAsAdmin(app));
  menu = await createMenu(app, token, {
    "Paha Atas": { price: 13000 },
    Dada: { price: 14000 },
    "Es Teh": { price: 5000, category: "Minuman" },
  });
  const PA = menu["Paha Atas"];
  const DA = menu.Dada;
  const ET = menu["Es Teh"];
  const sale = (soldAt: string, items: [string, number][], paymentMethod: string, extra: Record<string, unknown> = {}) =>
    createSale(app, token, { soldAt, paymentMethod, items: items.map(([productId, qty]) => ({ productId, qty })), ...extra });

  // previous period (29–31 Aug)
  await sale("2026-08-30T05:00:00Z", [[PA, 2]], "CASH");
  // current period (1–3 Sep); comments show WIB time
  await sale("2026-09-01T03:00:00Z", [[PA, 2]], "CASH"); //                     10:00  26.000
  await sale("2026-09-01T05:30:00Z", [[DA, 1], [ET, 2]], "QRIS", { orderType: "ONLINE", discount: 4000 }); // 12:30  24.000−4.000
  await sale("2026-09-01T12:00:00Z", [[ET, 1]], "CASH"); //                     19:00   5.000
  await sale("2026-09-02T04:00:00Z", [[PA, 1], [DA, 1]], "TRANSFER"); //        11:00  27.000
  const voided = await sale("2026-09-02T11:00:00Z", [[PA, 3]], "CASH"); //      18:00  39.000 (void)
  await sale("2026-09-02T16:59:00Z", [[PA, 1]], "QRIS"); //                     23:59  13.000
  await sale("2026-09-03T05:00:00Z", [[DA, 2]], "EWALLET", { orderType: "ONLINE" }); // 12:00 28.000
  await sale("2026-09-03T12:30:00Z", [[ET, 4]], "CASH"); //                     19:30  20.000
  await call(app, "POST", `/api/v1/sales/${voided.id}/void`, { token, body: { reason: "Salah input" } });

  const catList = await call(app, "GET", "/api/v1/expense-categories", { token });
  cats = Object.fromEntries(catList.body.map((c: { name: string; id: string }) => [c.name, c.id]));
  const expense = async (expenseDate: string, cat: string, amount: number, paymentMethod: string) => {
    const r = await call(app, "POST", "/api/v1/expenses", {
      token,
      body: { expenseDate, categoryId: cats[cat], amount, paymentMethod, description: `${cat} ${expenseDate}` },
    });
    return r.body.id as string;
  };
  await expense("2026-08-31", "Gas/LPG", 20000, "CASH");
  await expense("2026-09-01", "Bahan Baku Ayam", 60000, "CASH");
  await expense("2026-09-02", "Gas/LPG", 25000, "CASH");
  await expense("2026-09-02", "Minyak Goreng", 40000, "QRIS");
  await expense("2026-09-03", "Bahan Baku Ayam", 30000, "TRANSFER");
  const deleted = await expense("2026-09-03", "Kemasan", 10000, "CASH");
  await call(app, "DELETE", `/api/v1/expenses/${deleted}`, { token });
});

const RANGE = "?from=2026-09-01&to=2026-09-03";

describe("reports", () => {
  test("summary with previous-period comparison", async () => {
    const r = await get(`/summary${RANGE}`);
    expect(r.status).toBe(200);
    expect(r.body.previousPeriod).toEqual({ from: "2026-08-29", to: "2026-08-31" });
    expect(r.body.grossSales).toEqual({ current: 143000, previous: 26000, change: 117000, changePct: 450 });
    expect(r.body.discounts).toEqual({ current: 4000, previous: 0, change: 4000, changePct: null });
    expect(r.body.netSales).toEqual({ current: 139000, previous: 26000, change: 113000, changePct: 434.62 });
    expect(r.body.transactionCount).toEqual({ current: 7, previous: 1, change: 6, changePct: 600 });
    expect(r.body.averageTicket.current).toBe(19857);
    expect(r.body.expenses).toEqual({ current: 155000, previous: 20000, change: 135000, changePct: 675 });
    expect(r.body.netProfit).toEqual({ current: -16000, previous: 6000, change: -22000, changePct: -366.67 });
  });

  test("daily trend includes empty days as zero", async () => {
    const r = await get("/trend?from=2026-09-01&to=2026-09-04");
    expect(r.body.series).toEqual([
      { period: "2026-09-01", netSales: 51000, expenses: 60000, netProfit: -9000 },
      { period: "2026-09-02", netSales: 40000, expenses: 65000, netProfit: -25000 },
      { period: "2026-09-03", netSales: 48000, expenses: 30000, netProfit: 18000 },
      { period: "2026-09-04", netSales: 0, expenses: 0, netProfit: 0 },
    ]);
  });

  test("monthly trend", async () => {
    const r = await get("/trend?from=2026-08-01&to=2026-09-30&granularity=month");
    expect(r.body.series).toEqual([
      { period: "2026-08-01", netSales: 26000, expenses: 20000, netProfit: 6000 },
      { period: "2026-09-01", netSales: 139000, expenses: 155000, netProfit: -16000 },
    ]);
  });

  test("top products by qty, ties broken by revenue; voided sale excluded", async () => {
    const r = await get(`/top-products${RANGE}`);
    expect(r.body.items.map((i: { productName: string; qtySold: number; revenue: number }) => [i.productName, i.qtySold, i.revenue])).toEqual([
      ["Es Teh", 7, 35000],
      ["Dada", 4, 56000],
      ["Paha Atas", 4, 52000],
    ]);
    expect((await get(`/top-products${RANGE}&limit=1`)).body.items.length).toBe(1);
    expect((await get(`/top-products${RANGE}&limit=51`)).status).toBe(422);
  });

  test("sales breakdown (hours in WIB) and consistency with summary", async () => {
    const r = await get(`/sales-breakdown${RANGE}`);
    const pm = Object.fromEntries(r.body.byPaymentMethod.items.map((i: { key: string; amount: number }) => [i.key, i.amount]));
    expect(pm).toEqual({ CASH: 51000, QRIS: 33000, TRANSFER: 27000, EWALLET: 28000 });
    const ot = Object.fromEntries(r.body.byOrderType.items.map((i: { key: string; amount: number }) => [i.key, i.amount]));
    expect(ot).toEqual({ TAKE_AWAY: 91000, ONLINE: 48000 });
    expect(r.body.byCategory.basis).toBe("gross");
    expect(r.body.byCategory.items.map((i: Record<string, unknown>) => [i.categoryName, i.amount, i.transactionCount, i.qtySold])).toEqual([
      ["Ayam", 108000, 5, 8],
      ["Minuman", 35000, 3, 7],
    ]);
    const hours = r.body.byHour.items.filter((h: { amount: number }) => h.amount > 0).map((h: { hour: number; amount: number }) => [h.hour, h.amount]);
    expect(hours).toEqual([
      [10, 26000],
      [11, 27000],
      [12, 48000],
      [19, 25000],
      [23, 13000],
    ]);
    expect(r.body.byHour.items.length).toBe(24);
    const summary = await get(`/summary${RANGE}`);
    const sum = (items: { amount: number }[]) => items.reduce((s, i) => s + i.amount, 0);
    expect(sum(r.body.byPaymentMethod.items)).toBe(summary.body.netSales.current);
    expect(sum(r.body.byHour.items)).toBe(summary.body.netSales.current);
    expect(sum(r.body.byCategory.items)).toBe(summary.body.grossSales.current);
  });

  test("expense breakdown with percentages (deleted expense excluded)", async () => {
    const r = await get(`/expense-breakdown${RANGE}`);
    expect(r.body.total).toBe(155000);
    expect(r.body.items.map((i: Record<string, unknown>) => [i.categoryName, i.amount, i.percentage])).toEqual([
      ["Bahan Baku Ayam", 90000, 58.06],
      ["Minyak Goreng", 40000, 25.81],
      ["Gas/LPG", 25000, 16.13],
    ]);
  });

  test("cash recap", async () => {
    const d2 = await get("/cash-recap?date=2026-09-02");
    expect(d2.body).toEqual({
      date: "2026-09-02",
      cashSales: 0,
      cashExpenses: 25000,
      cashNet: -25000,
      nonCashSales: { QRIS: 13000, TRANSFER: 27000, EWALLET: 0 },
      nonCashExpenses: { QRIS: 40000, TRANSFER: 0, EWALLET: 0 },
    });
    const d1 = await get("/cash-recap?date=2026-09-01");
    expect(d1.body).toMatchObject({ cashSales: 31000, cashExpenses: 60000, cashNet: -29000 });
  });

  test("aggregates match raw rows", async () => {
    const { db } = await getTestDb();
    const [raw] = await db.execute<{ net: string; exp: string }>(sql`
      SELECT (SELECT sum(total) FROM sales WHERE status = 'COMPLETED' AND business_date BETWEEN '2026-09-01' AND '2026-09-03') AS net,
             (SELECT sum(amount) FROM expenses WHERE deleted_at IS NULL AND expense_date BETWEEN '2026-09-01' AND '2026-09-03') AS exp`);
    const s = await get(`/summary${RANGE}`);
    expect(s.body.netSales.current).toBe(Number(raw.net));
    expect(s.body.expenses.current).toBe(Number(raw.exp));
  });

  test("range validation", async () => {
    expect((await get("/summary?from=2026-09-03&to=2026-09-01")).body.error.code).toBe("INVALID_DATE_RANGE");
    expect((await get("/summary?from=2025-01-01&to=2026-09-01")).body.error.code).toBe("DATE_RANGE_TOO_LARGE");
    expect((await get("/summary?from=2026-13-01")).status).toBe(422);
    const today = await get("/summary");
    expect(today.status).toBe(200);
    expect(today.body.period.from).toBe(today.body.period.to);
  });
});
