import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import type { DB } from "../../db/client";
import { expenseCategories, expenses } from "../../db/schema";
import { writeAudit, type AuditContext } from "../../lib/audit";
import { conflict, notFound } from "../../lib/errors";
import { iso } from "../common";

type Row = typeof expenseCategories.$inferSelect;

export const toExpenseCategoryDto = (r: Row) => ({
  id: r.id,
  name: r.name,
  isActive: r.isActive,
  createdAt: iso(r.createdAt)!,
  updatedAt: iso(r.updatedAt)!,
});

export class ExpenseCategoryService {
  constructor(
    private readonly db: DB,
    private readonly now: () => Date,
  ) {}

  async list(q: { isActive?: boolean }) {
    const where: SQL[] = [];
    if (q.isActive !== undefined) where.push(eq(expenseCategories.isActive, q.isActive));
    const rows = await this.db
      .select()
      .from(expenseCategories)
      .where(where.length ? and(...where) : undefined)
      .orderBy(asc(expenseCategories.name));
    return rows.map(toExpenseCategoryDto);
  }

  async create(input: { name: string; isActive?: boolean }, ctx: AuditContext) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(expenseCategories)
        .values({ name: input.name.trim(), isActive: input.isActive ?? true })
        .returning();
      await writeAudit(tx, {
        action: "expense_category.created",
        entityType: "expense_category",
        entityId: row.id,
        after: toExpenseCategoryDto(row),
        ctx,
      });
      return toExpenseCategoryDto(row);
    });
  }

  async update(id: string, input: { name?: string; isActive?: boolean }, ctx: AuditContext) {
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(expenseCategories).where(eq(expenseCategories.id, id)).for("update");
      if (!before) throw notFound("Kategori pengeluaran tidak ditemukan");
      const [row] = await tx
        .update(expenseCategories)
        .set({
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          updatedAt: this.now(),
        })
        .where(eq(expenseCategories.id, id))
        .returning();
      await writeAudit(tx, {
        action: "expense_category.updated",
        entityType: "expense_category",
        entityId: id,
        before: toExpenseCategoryDto(before),
        after: toExpenseCategoryDto(row),
        ctx,
      });
      return toExpenseCategoryDto(row);
    });
  }

  async remove(id: string, ctx: AuditContext) {
    await this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(expenseCategories).where(eq(expenseCategories.id, id)).for("update");
      if (!before) throw notFound("Kategori pengeluaran tidak ditemukan");
      // Soft-deleted expenses still reference the category, so they count as "in use".
      const used = await tx.execute(sql`select 1 from ${expenses} where ${expenses.categoryId} = ${id} limit 1`);
      if (used.length) throw conflict("CATEGORY_IN_USE", "Kategori sudah dipakai, nonaktifkan saja");
      await tx.delete(expenseCategories).where(eq(expenseCategories.id, id));
      await writeAudit(tx, {
        action: "expense_category.deleted",
        entityType: "expense_category",
        entityId: id,
        before: toExpenseCategoryDto(before),
        ctx,
      });
    });
  }
}
