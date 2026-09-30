import { sql, type SQL } from "drizzle-orm";
import type { DB } from "../../db/client";
import type { CsvValue } from "../../lib/csv";
import { formatWib, type DateRange } from "../../lib/time";

export const BATCH_SIZE = 1000;

export const SALES_COLUMNS = [
  "receipt_no",
  "business_date",
  "sold_at_wib",
  "order_type",
  "payment_method",
  "subtotal",
  "discount",
  "total",
  "cash_received",
  "change_amount",
  "status",
  "void_reason",
  "note",
];

export const SALE_ITEMS_COLUMNS = [
  "receipt_no",
  "business_date",
  "product_name",
  "category_name",
  "unit_price",
  "qty",
  "line_total",
  "sale_status",
];

export const EXPENSES_COLUMNS = ["expense_date", "category", "description", "vendor", "payment_method", "amount", "has_attachment"];

const d = (v: string | Date) => (v instanceof Date ? v : new Date(v));

/** Keyset-paginated readers: each yields batches of CSV rows. */
export class ExportService {
  constructor(
    private readonly db: DB,
    private readonly batchSize = BATCH_SIZE,
  ) {}

  async *sales(r: DateRange): AsyncGenerator<CsvValue[][]> {
    let cursor: { soldAt: string; id: string } | null = null;
    for (;;) {
      const after: SQL = cursor ? sql`AND (sold_at, id) > (${cursor.soldAt}::timestamptz, ${cursor.id}::uuid)` : sql``;
      const rows = await this.db.execute<Record<string, string | number | null> & { sold_at: string; id: string }>(sql`
        SELECT id, receipt_no, business_date::text AS business_date, sold_at, order_type, payment_method,
               subtotal, discount, total, cash_received, change_amount, status, void_reason, note
        FROM sales
        WHERE business_date BETWEEN ${r.from} AND ${r.to} ${after}
        ORDER BY sold_at, id
        LIMIT ${this.batchSize}`);
      if (!rows.length) return;
      yield rows.map((x) => [
        x.receipt_no,
        x.business_date,
        formatWib(d(x.sold_at)),
        x.order_type,
        x.payment_method,
        x.subtotal,
        x.discount,
        x.total,
        x.cash_received,
        x.change_amount,
        x.status,
        x.void_reason,
        x.note,
      ]);
      const last = rows[rows.length - 1];
      cursor = { soldAt: d(last.sold_at).toISOString(), id: last.id };
      if (rows.length < this.batchSize) return;
    }
  }

  async *saleItems(r: DateRange): AsyncGenerator<CsvValue[][]> {
    let cursor: { soldAt: string; saleId: string; position: number } | null = null;
    for (;;) {
      const after: SQL = cursor
        ? sql`AND (s.sold_at, s.id, si.position) > (${cursor.soldAt}::timestamptz, ${cursor.saleId}::uuid, ${cursor.position}::int)`
        : sql``;
      const rows = await this.db.execute<Record<string, string | number | null> & { sold_at: string; sale_id: string; position: number }>(sql`
        SELECT s.id AS sale_id, s.sold_at, si.position, s.receipt_no, s.business_date::text AS business_date,
               si.product_name, si.category_name, si.unit_price, si.qty, si.line_total, s.status AS sale_status
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        WHERE s.business_date BETWEEN ${r.from} AND ${r.to} ${after}
        ORDER BY s.sold_at, s.id, si.position
        LIMIT ${this.batchSize}`);
      if (!rows.length) return;
      yield rows.map((x) => [
        x.receipt_no,
        x.business_date,
        x.product_name,
        x.category_name,
        x.unit_price,
        x.qty,
        x.line_total,
        x.sale_status,
      ]);
      const last = rows[rows.length - 1];
      cursor = { soldAt: d(last.sold_at).toISOString(), saleId: last.sale_id, position: Number(last.position) };
      if (rows.length < this.batchSize) return;
    }
  }

  async *expenses(r: DateRange): AsyncGenerator<CsvValue[][]> {
    let cursor: { date: string; createdAt: string; id: string } | null = null;
    for (;;) {
      const after: SQL = cursor
        ? sql`AND (e.expense_date, e.created_at, e.id) > (${cursor.date}::date, ${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
        : sql``;
      const rows = await this.db.execute<
        Record<string, string | number | boolean | null> & { expense_date: string; created_at: string; id: string }
      >(sql`
        SELECT e.id, e.expense_date::text AS expense_date, e.created_at, ec.name AS category, e.description, e.vendor,
               e.payment_method, e.amount, (e.attachment_path IS NOT NULL) AS has_attachment
        FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id
        WHERE e.deleted_at IS NULL AND e.expense_date BETWEEN ${r.from} AND ${r.to} ${after}
        ORDER BY e.expense_date, e.created_at, e.id
        LIMIT ${this.batchSize}`);
      if (!rows.length) return;
      yield rows.map((x) => [x.expense_date, x.category, x.description, x.vendor, x.payment_method, x.amount, x.has_attachment]);
      const last = rows[rows.length - 1];
      cursor = { date: last.expense_date, createdAt: d(last.created_at).toISOString(), id: last.id };
      if (rows.length < this.batchSize) return;
    }
  }
}
