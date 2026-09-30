import { beforeAll, describe, expect, test } from "bun:test";
import { count, eq, sql } from "drizzle-orm";
import { admins, auditLogs, expenseCategories } from "../../src/db/schema";
import { seed } from "../../src/db/seed";
import { getTestDb, resetDb } from "../helpers";

beforeAll(resetDb);

describe("database", () => {
  test("seed is idempotent and never overwrites the password", async () => {
    const { db } = await getTestDb();
    const first = await seed(db, { email: "Owner@Toko.test", password: "password-1", name: "Owner" });
    expect(first).toEqual({ adminCreated: true, categoriesInserted: 11 });
    const [before] = await db.select().from(admins);

    const second = await seed(db, { email: "other@toko.test", password: "password-2", name: "Other" });
    expect(second).toEqual({ adminCreated: false, categoriesInserted: 0 });

    const rows = await db.select().from(admins);
    expect(rows.length).toBe(1);
    expect(rows[0].passwordHash).toBe(before.passwordHash);
    expect(await Bun.password.verify("password-1", rows[0].passwordHash)).toBe(true);
    const [{ n }] = await db.select({ n: count() }).from(expenseCategories);
    expect(n).toBe(11);
  });

  test("audit_logs rejects UPDATE and DELETE", async () => {
    const { db } = await getTestDb();
    await db.insert(auditLogs).values({ action: "test", entityType: "test" });
    const causeOf = async (q: PromiseLike<unknown>) => {
      try {
        await q;
        return "no error";
      } catch (e) {
        return String((e as { cause?: { message?: string } }).cause?.message);
      }
    };
    expect(await causeOf(db.update(auditLogs).set({ action: "x" }).where(eq(auditLogs.action, "test")))).toBe(
      "audit_logs is append-only",
    );
    expect(await causeOf(db.delete(auditLogs).where(eq(auditLogs.action, "test")))).toBe("audit_logs is append-only");
    const [{ n }] = await db.select({ n: count() }).from(auditLogs);
    expect(n).toBe(1);
  });

  test("CHECK constraints reject inconsistent sales and items", async () => {
    const { db } = await getTestDb();
    await expect(async () => {
      await db.execute(sql`INSERT INTO sales (receipt_no, business_date, sold_at, payment_method, subtotal, discount, total)
                     VALUES ('INV-X', '2026-09-29', now(), 'QRIS', 10000, 0, 9000)`);
    }).toThrow();
    await expect(async () => {
      await db.execute(sql`INSERT INTO sales (receipt_no, business_date, sold_at, payment_method, subtotal, discount, total)
                     VALUES ('INV-Y', '2026-09-29', now(), 'QRIS', 10000, 12000, -2000)`);
    }).toThrow();
    await expect(async () => {
      await db.execute(sql`INSERT INTO sale_items (sale_id, product_id, product_name, category_id, category_name, unit_price, qty, line_total)
                     VALUES (gen_random_uuid(), gen_random_uuid(), 'x', gen_random_uuid(), 'c', 1000, 0, 0)`);
    }).toThrow();
  });
});
