import { Elysia, t } from "elysia";
import type { ModuleContext } from "../../app";
import { parseDateRange } from "../../lib/time";
import { bearer, errorResponses, TAGS } from "../../plugins/openapi";
import { DateRangeQuery, DateString, Uuid } from "../common";
import { ReportService } from "./service";

const Range = t.Object({ from: t.String(), to: t.String() });
const Cmp = t.Object({ current: t.Integer(), previous: t.Integer(), change: t.Integer(), changePct: t.Nullable(t.Number()) });

const SummarySchema = t.Object(
  {
    period: Range,
    previousPeriod: Range,
    grossSales: Cmp,
    discounts: Cmp,
    netSales: Cmp,
    transactionCount: Cmp,
    averageTicket: Cmp,
    expenses: Cmp,
    netProfit: Cmp,
  },
  {
    examples: [
      {
        period: { from: "2026-09-01", to: "2026-09-03" },
        previousPeriod: { from: "2026-08-29", to: "2026-08-31" },
        grossSales: { current: 143000, previous: 26000, change: 117000, changePct: 450 },
        discounts: { current: 4000, previous: 0, change: 4000, changePct: null },
        netSales: { current: 139000, previous: 26000, change: 113000, changePct: 434.62 },
        transactionCount: { current: 7, previous: 1, change: 6, changePct: 600 },
        averageTicket: { current: 19857, previous: 26000, change: -6143, changePct: -23.63 },
        expenses: { current: 155000, previous: 20000, change: 135000, changePct: 675 },
        netProfit: { current: -16000, previous: 6000, change: -22000, changePct: -366.67 },
      },
    ],
  },
);

const TrendSchema = t.Object({
  period: Range,
  granularity: t.Union([t.Literal("day"), t.Literal("month")]),
  series: t.Array(t.Object({ period: t.String(), netSales: t.Integer(), expenses: t.Integer(), netProfit: t.Integer() })),
});

const TopProductsSchema = t.Object({
  period: Range,
  items: t.Array(
    t.Object({ productId: Uuid, productName: t.String(), qtySold: t.Integer(), revenue: t.Integer(), transactionCount: t.Integer() }),
  ),
});

const KeyedItem = t.Object({ key: t.String(), transactionCount: t.Integer(), amount: t.Integer() });
const Net = t.Literal("net");
const SalesBreakdownSchema = t.Object({
  period: Range,
  byPaymentMethod: t.Object({ basis: Net, items: t.Array(KeyedItem) }),
  byOrderType: t.Object({ basis: Net, items: t.Array(KeyedItem) }),
  byCategory: t.Object({
    basis: t.Literal("gross"),
    items: t.Array(
      t.Object({ categoryId: Uuid, categoryName: t.String(), transactionCount: t.Integer(), qtySold: t.Integer(), amount: t.Integer() }),
    ),
  }),
  byHour: t.Object({ basis: Net, items: t.Array(t.Object({ hour: t.Integer(), transactionCount: t.Integer(), amount: t.Integer() })) }),
});

const ExpenseBreakdownSchema = t.Object({
  period: Range,
  total: t.Integer(),
  items: t.Array(
    t.Object({ categoryId: Uuid, categoryName: t.String(), count: t.Integer(), amount: t.Integer(), percentage: t.Number() }),
  ),
});

const NonCash = t.Object({ QRIS: t.Integer(), TRANSFER: t.Integer(), EWALLET: t.Integer() });
const CashRecapSchema = t.Object({
  date: t.String(),
  cashSales: t.Integer(),
  cashExpenses: t.Integer(),
  cashNet: t.Integer(),
  nonCashSales: NonCash,
  nonCashExpenses: NonCash,
});

const RangeQuery = t.Object(DateRangeQuery);

export function reportRoutes(m: ModuleContext) {
  const svc = new ReportService(m.db);
  const tags = [TAGS.reports];
  const range = (q: { from?: string; to?: string }) => parseDateRange(q.from, q.to, { now: m.now() });
  const note = "Tanggal = hari bisnis WIB, default hari ini, maksimal 366 hari. Hanya penjualan COMPLETED dan pengeluaran yang tidak dihapus.";

  return new Elysia({ prefix: "/reports" })
    .use(m.auth)
    .guard({ auth: true, detail: { security: bearer } })
    .get("/summary", ({ query }) => svc.summary(range(query)), {
      query: RangeQuery,
      response: { 200: SummarySchema, ...errorResponses },
      detail: {
        tags,
        summary: "Ringkasan omzet, pengeluaran, laba + perbandingan periode sebelumnya",
        description: `${note} \`changePct\` = null bila nilai periode sebelumnya 0.`,
      },
    })
    .get("/trend", ({ query }) => svc.trend(range(query), query.granularity ?? "day"), {
      query: t.Object({ ...DateRangeQuery, granularity: t.Optional(t.Union([t.Literal("day"), t.Literal("month")])) }),
      response: { 200: TrendSchema, ...errorResponses },
      detail: { tags, summary: "Tren harian/bulanan", description: `${note} Hari/bulan tanpa transaksi bernilai 0.` },
    })
    .get("/top-products", ({ query }) => svc.topProducts(range(query), query.limit ?? 10), {
      query: t.Object({ ...DateRangeQuery, limit: t.Optional(t.Integer({ minimum: 1, maximum: 50 })) }),
      response: { 200: TopProductsSchema, ...errorResponses },
      detail: { tags, summary: "Produk terlaris (berdasarkan qty)", description: note },
    })
    .get("/sales-breakdown", ({ query }) => svc.salesBreakdown(range(query)), {
      query: RangeQuery,
      response: { 200: SalesBreakdownSchema, ...errorResponses },
      detail: {
        tags,
        summary: "Rincian penjualan per metode bayar, tipe pesanan, kategori, dan jam (WIB)",
        description: `${note} \`basis: gross\` (per kategori) = sebelum diskon transaksi; \`basis: net\` = setelah diskon.`,
      },
    })
    .get("/expense-breakdown", ({ query }) => svc.expenseBreakdown(range(query)), {
      query: RangeQuery,
      response: { 200: ExpenseBreakdownSchema, ...errorResponses },
      detail: { tags, summary: "Rincian pengeluaran per kategori", description: note },
    })
    .get("/cash-recap", ({ query }) => svc.cashRecap(range({ from: query.date, to: query.date }).from), {
      query: t.Object({ date: t.Optional(DateString) }),
      response: { 200: CashRecapSchema, ...errorResponses },
      detail: { tags, summary: "Rekap kas harian", description: "Penerimaan & pengeluaran tunai, selisih kas, dan total non-tunai per metode." },
    });
}
