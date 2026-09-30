import { asc, eq, sql } from "drizzle-orm";
import type { DB } from "../../db/client";
import { productCategories, products } from "../../db/schema";
import { writeAudit, type AuditContext } from "../../lib/audit";
import { conflict, notFound } from "../../lib/errors";
import { iso } from "../common";

type Row = typeof productCategories.$inferSelect;

export const toCategoryDto = (r: Row) => ({
  id: r.id,
  name: r.name,
  sortOrder: r.sortOrder,
  createdAt: iso(r.createdAt)!,
  updatedAt: iso(r.updatedAt)!,
});

export class ProductCategoryService {
  constructor(
    private readonly db: DB,
    private readonly now: () => Date,
  ) {}

  async list() {
    const rows = await this.db
      .select()
      .from(productCategories)
      .orderBy(asc(productCategories.sortOrder), asc(productCategories.name));
    return rows.map(toCategoryDto);
  }

  async create(input: { name: string; sortOrder?: number }, ctx: AuditContext) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(productCategories)
        .values({ name: input.name.trim(), sortOrder: input.sortOrder ?? 0 })
        .returning();
      await writeAudit(tx, {
        action: "product_category.created",
        entityType: "product_category",
        entityId: row.id,
        after: toCategoryDto(row),
        ctx,
      });
      return toCategoryDto(row);
    });
  }

  async update(id: string, input: { name?: string; sortOrder?: number }, ctx: AuditContext) {
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(productCategories).where(eq(productCategories.id, id)).for("update");
      if (!before) throw notFound("Kategori produk tidak ditemukan");
      const [row] = await tx
        .update(productCategories)
        .set({
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
          updatedAt: this.now(),
        })
        .where(eq(productCategories.id, id))
        .returning();
      await writeAudit(tx, {
        action: "product_category.updated",
        entityType: "product_category",
        entityId: id,
        before: toCategoryDto(before),
        after: toCategoryDto(row),
        ctx,
      });
      return toCategoryDto(row);
    });
  }

  async remove(id: string, ctx: AuditContext) {
    await this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(productCategories).where(eq(productCategories.id, id)).for("update");
      if (!before) throw notFound("Kategori produk tidak ditemukan");
      const used = await tx.execute(sql`select 1 from ${products} where ${products.categoryId} = ${id} limit 1`);
      if (used.length) throw conflict("CATEGORY_IN_USE", "Kategori masih dipakai produk");
      await tx.delete(productCategories).where(eq(productCategories.id, id));
      await writeAudit(tx, {
        action: "product_category.deleted",
        entityType: "product_category",
        entityId: id,
        before: toCategoryDto(before),
        ctx,
      });
    });
  }
}
