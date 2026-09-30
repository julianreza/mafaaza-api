import { sql } from "drizzle-orm";
import type { Executor } from "../../src/db/client";

export const PERF_FROM = "2026-08-01";
export const PERF_TO = "2026-08-31";

/**
 * Server-side bulk seed: 10 products, `n` COMPLETED sales spread over 31 days
 * (1–3 items each, mixed payment methods / order types) and ~20 expenses per day.
 */
export async function seedPerfData(db: Executor, n = 30_000): Promise<void> {
  await db.execute(sql`
    INSERT INTO product_categories (name) VALUES ('Perf Ayam'), ('Perf Minuman') ON CONFLICT DO NOTHING`);
  await db.execute(sql`
    INSERT INTO products (category_id, name, price)
    SELECT (SELECT id FROM product_categories WHERE name = CASE WHEN g <= 7 THEN 'Perf Ayam' ELSE 'Perf Minuman' END),
           'Perf Produk ' || g, 5000 + g * 1000
    FROM generate_series(1, 10) g`);
  await db.execute(sql`
    WITH p AS (
      SELECT p.id, p.name, p.price, c.id AS cid, c.name AS cname, row_number() OVER (ORDER BY p.name) AS rn
      FROM products p JOIN product_categories c ON c.id = p.category_id WHERE p.name LIKE 'Perf Produk %'
    ),
    s AS (
      SELECT g,
             (timestamp '2026-07-31 17:00:00' + (random() * interval '31 days')) AT TIME ZONE 'UTC' AS sold_at,
             1 + (g % 3) AS n_items
      FROM generate_series(1, ${n}) g
    ),
    items AS (
      SELECT s.g, s.sold_at, i AS position, p.*
      FROM s CROSS JOIN LATERAL generate_series(0, s.n_items - 1) i
      JOIN p ON p.rn = 1 + ((s.g + i * 3) % 10)
    ),
    sums AS (
      SELECT g, min(sold_at) AS sold_at, sum(price)::int AS subtotal FROM items GROUP BY g
    ),
    ins AS (
      INSERT INTO sales (receipt_no, business_date, sold_at, order_type, payment_method, subtotal, discount, total)
      SELECT 'PERF-' || g,
             ((sold_at AT TIME ZONE 'Asia/Jakarta')::date),
             sold_at,
             (CASE WHEN g % 4 = 0 THEN 'ONLINE' ELSE 'TAKE_AWAY' END)::order_type,
             (ARRAY['CASH','QRIS','TRANSFER','EWALLET'])[1 + g % 4]::payment_method,
             subtotal, 0, subtotal
      FROM sums
      RETURNING id, receipt_no
    )
    INSERT INTO sale_items (sale_id, product_id, product_name, category_id, category_name, unit_price, qty, line_total, position)
    SELECT ins.id, items.id, items.name, items.cid, items.cname, items.price, 1, items.price, items.position
    FROM items JOIN ins ON ins.receipt_no = 'PERF-' || items.g`);
  await db.execute(sql`
    INSERT INTO expenses (expense_date, category_id, amount, payment_method, description)
    SELECT d::date, (SELECT id FROM expense_categories ORDER BY name LIMIT 1), 10000 + (random() * 90000)::int, 'CASH', 'perf'
    FROM generate_series(${PERF_FROM}::date, ${PERF_TO}::date, interval '1 day') d, generate_series(1, 20)`);
  await db.execute(sql`ANALYZE`);
}
