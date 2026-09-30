import { sql } from "drizzle-orm";
import type { DB } from "../../db/client";
import { ORDER_TYPES, PAYMENT_METHODS } from "../../db/schema";
import { previousPeriod, type DateRange } from "../../lib/time";

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => Number(v ?? 0);

export interface Comparison {
  current: number;
  previous: number;
  change: number;
  changePct: number | null;
}

export function compare(current: number, previous: number): Comparison {
  return {
    current,
    previous,
    change: current - previous,
    changePct: previous === 0 ? null : round2(((current - previous) / Math.abs(previous)) * 100),
  };
}

// Every report counts COMPLETED sales and non-deleted expenses only.
const COMPLETED = sql.raw(`status = 'COMPLETED'`);

export class ReportService {
  constructor(private readonly db: DB) {}

  private async salesTotals(r: DateRange) {
    const [row] = await this.db.execute<{ gross: string; discounts: string; net: string; cnt: string }>(sql`
      SELECT coalesce(sum(subtotal), 0)::bigint AS gross,
             coalesce(sum(discount), 0)::bigint AS discounts,
             coalesce(sum(total), 0)::bigint    AS net,
             count(*)::bigint                   AS cnt
      FROM sales
      WHERE ${COMPLETED} AND business_date BETWEEN ${r.from} AND ${r.to}`);
    return { gross: num(row.gross), discounts: num(row.discounts), net: num(row.net), count: num(row.cnt) };
  }

  private async expenseTotal(r: DateRange) {
    const [row] = await this.db.execute<{ amount: string }>(sql`
      SELECT coalesce(sum(amount), 0)::bigint AS amount
      FROM expenses
      WHERE deleted_at IS NULL AND expense_date BETWEEN ${r.from} AND ${r.to}`);
    return num(row.amount);
  }

  async summary(range: DateRange) {
    const prev = previousPeriod(range);
    const [cs, ps, ce, pe] = await Promise.all([
      this.salesTotals(range),
      this.salesTotals(prev),
      this.expenseTotal(range),
      this.expenseTotal(prev),
    ]);
    const avg = (s: { net: number; count: number }) => (s.count > 0 ? Math.round(s.net / s.count) : 0);
    return {
      period: range,
      previousPeriod: prev,
      grossSales: compare(cs.gross, ps.gross),
      discounts: compare(cs.discounts, ps.discounts),
      netSales: compare(cs.net, ps.net),
      transactionCount: compare(cs.count, ps.count),
      averageTicket: compare(avg(cs), avg(ps)),
      expenses: compare(ce, pe),
      netProfit: compare(cs.net - ce, ps.net - pe),
    };
  }

  async trend(range: DateRange, granularity: "day" | "month") {
    const unit = granularity === "month" ? sql.raw(`'month'`) : sql.raw(`'day'`);
    const step = granularity === "month" ? sql.raw(`interval '1 month'`) : sql.raw(`interval '1 day'`);
    const rows = await this.db.execute<{ period: string; net: string; exp: string }>(sql`
      WITH buckets AS (
        SELECT generate_series(date_trunc(${unit}, ${range.from}::date), date_trunc(${unit}, ${range.to}::date), ${step})::date AS period
      ),
      s AS (
        SELECT date_trunc(${unit}, business_date)::date AS period, sum(total) AS net
        FROM sales WHERE ${COMPLETED} AND business_date BETWEEN ${range.from} AND ${range.to}
        GROUP BY 1
      ),
      e AS (
        SELECT date_trunc(${unit}, expense_date)::date AS period, sum(amount) AS exp
        FROM expenses WHERE deleted_at IS NULL AND expense_date BETWEEN ${range.from} AND ${range.to}
        GROUP BY 1
      )
      SELECT to_char(b.period, 'YYYY-MM-DD') AS period,
             coalesce(s.net, 0)::bigint AS net,
             coalesce(e.exp, 0)::bigint AS exp
      FROM buckets b LEFT JOIN s USING (period) LEFT JOIN e USING (period)
      ORDER BY b.period`);
    return {
      period: range,
      granularity,
      series: rows.map((r) => ({
        period: r.period,
        netSales: num(r.net),
        expenses: num(r.exp),
        netProfit: num(r.net) - num(r.exp),
      })),
    };
  }

  async topProducts(range: DateRange, limit: number) {
    const rows = await this.db.execute<{ product_id: string; name: string; qty: string; revenue: string; tx: string }>(sql`
      SELECT si.product_id, p.name,
             sum(si.qty)::bigint AS qty,
             sum(si.line_total)::bigint AS revenue,
             count(DISTINCT si.sale_id)::bigint AS tx
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      JOIN products p ON p.id = si.product_id
      WHERE s.${COMPLETED} AND s.business_date BETWEEN ${range.from} AND ${range.to}
      GROUP BY si.product_id, p.name
      ORDER BY qty DESC, revenue DESC, p.name
      LIMIT ${limit}`);
    return {
      period: range,
      items: rows.map((r) => ({
        productId: r.product_id,
        productName: r.name,
        qtySold: num(r.qty),
        revenue: num(r.revenue),
        transactionCount: num(r.tx),
      })),
    };
  }

  async salesBreakdown(range: DateRange) {
    const where = sql`${COMPLETED} AND business_date BETWEEN ${range.from} AND ${range.to}`;
    const [byPm, byOt, byCat, byHour] = await Promise.all([
      this.db.execute<{ k: string; cnt: string; amt: string }>(
        sql`SELECT payment_method AS k, count(*)::bigint AS cnt, sum(total)::bigint AS amt FROM sales WHERE ${where} GROUP BY 1`,
      ),
      this.db.execute<{ k: string; cnt: string; amt: string }>(
        sql`SELECT order_type AS k, count(*)::bigint AS cnt, sum(total)::bigint AS amt FROM sales WHERE ${where} GROUP BY 1`,
      ),
      this.db.execute<{ id: string; name: string; cnt: string; qty: string; amt: string }>(sql`
        SELECT si.category_id AS id,
               coalesce(pc.name, max(si.category_name)) AS name,
               count(DISTINCT si.sale_id)::bigint AS cnt,
               sum(si.qty)::bigint AS qty,
               sum(si.line_total)::bigint AS amt
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        LEFT JOIN product_categories pc ON pc.id = si.category_id
        WHERE s.${COMPLETED} AND s.business_date BETWEEN ${range.from} AND ${range.to}
        GROUP BY si.category_id, pc.name
        ORDER BY amt DESC, name`),
      this.db.execute<{ h: number; cnt: string; amt: string }>(sql`
        SELECT extract(hour FROM sold_at AT TIME ZONE 'Asia/Jakarta')::int AS h,
               count(*)::bigint AS cnt, sum(total)::bigint AS amt
        FROM sales WHERE ${where} GROUP BY 1`),
    ]);
    const fill = <K extends string>(keys: readonly K[], rows: { k: string; cnt: string; amt: string }[]) =>
      keys.map((k) => {
        const r = rows.find((x) => x.k === k);
        return { key: k, transactionCount: num(r?.cnt), amount: num(r?.amt) };
      });
    return {
      period: range,
      byPaymentMethod: { basis: "net" as const, items: fill(PAYMENT_METHODS, byPm) },
      byOrderType: { basis: "net" as const, items: fill(ORDER_TYPES, byOt) },
      byCategory: {
        basis: "gross" as const,
        items: byCat.map((r) => ({
          categoryId: r.id,
          categoryName: r.name,
          transactionCount: num(r.cnt),
          qtySold: num(r.qty),
          amount: num(r.amt),
        })),
      },
      byHour: {
        basis: "net" as const,
        items: Array.from({ length: 24 }, (_, hour) => {
          const r = byHour.find((x) => Number(x.h) === hour);
          return { hour, transactionCount: num(r?.cnt), amount: num(r?.amt) };
        }),
      },
    };
  }

  async expenseBreakdown(range: DateRange) {
    const rows = await this.db.execute<{ id: string; name: string; cnt: string; amt: string }>(sql`
      SELECT ec.id, ec.name, count(*)::bigint AS cnt, sum(e.amount)::bigint AS amt
      FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id
      WHERE e.deleted_at IS NULL AND e.expense_date BETWEEN ${range.from} AND ${range.to}
      GROUP BY ec.id, ec.name
      ORDER BY amt DESC, ec.name`);
    const total = rows.reduce((s, r) => s + num(r.amt), 0);
    return {
      period: range,
      total,
      items: rows.map((r) => ({
        categoryId: r.id,
        categoryName: r.name,
        count: num(r.cnt),
        amount: num(r.amt),
        percentage: total === 0 ? 0 : round2((num(r.amt) / total) * 100),
      })),
    };
  }

  async cashRecap(date: string) {
    const [salesRows, expRows] = await Promise.all([
      this.db.execute<{ k: string; amt: string }>(sql`
        SELECT payment_method AS k, sum(total)::bigint AS amt FROM sales
        WHERE ${COMPLETED} AND business_date = ${date} GROUP BY 1`),
      this.db.execute<{ k: string; amt: string }>(sql`
        SELECT payment_method AS k, sum(amount)::bigint AS amt FROM expenses
        WHERE deleted_at IS NULL AND expense_date = ${date} GROUP BY 1`),
    ]);
    const get = (rows: { k: string; amt: string }[], k: string) => num(rows.find((r) => r.k === k)?.amt);
    const nonCash = PAYMENT_METHODS.filter((p) => p !== "CASH");
    const cashSales = get(salesRows, "CASH");
    const cashExpenses = get(expRows, "CASH");
    return {
      date,
      cashSales,
      cashExpenses,
      cashNet: cashSales - cashExpenses,
      nonCashSales: Object.fromEntries(nonCash.map((k) => [k, get(salesRows, k)])) as Record<(typeof nonCash)[number], number>,
      nonCashExpenses: Object.fromEntries(nonCash.map((k) => [k, get(expRows, k)])) as Record<(typeof nonCash)[number], number>,
    };
  }
}
