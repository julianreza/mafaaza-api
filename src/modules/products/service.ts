import { and, asc, count, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import type { DB, Executor } from "../../db/client";
import { productCategories, products, saleItems } from "../../db/schema";
import { writeAudit, type AuditContext } from "../../lib/audit";
import { conflict, notFound, unprocessable } from "../../lib/errors";
import { likePattern, pageMeta, toPage } from "../../lib/pagination";
import { iso } from "../common";

export interface ProductInput {
  categoryId: string;
  name: string;
  price: number;
  sku?: string | null;
  description?: string | null;
  isActive?: boolean;
}

const cols = {
  id: products.id,
  categoryId: products.categoryId,
  categoryName: productCategories.name,
  name: products.name,
  sku: products.sku,
  description: products.description,
  price: products.price,
  isActive: products.isActive,
  createdAt: products.createdAt,
  updatedAt: products.updatedAt,
};

type Joined = {
  id: string;
  categoryId: string;
  categoryName: string;
  name: string;
  sku: string | null;
  description: string | null;
  price: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export const toProductDto = (r: Joined) => ({
  id: r.id,
  name: r.name,
  sku: r.sku,
  description: r.description,
  price: r.price,
  isActive: r.isActive,
  category: { id: r.categoryId, name: r.categoryName },
  createdAt: iso(r.createdAt)!,
  updatedAt: iso(r.updatedAt)!,
});

const normSku = (s: string | null | undefined) => (s === undefined ? undefined : s?.trim() ? s.trim() : null);

export class ProductService {
  constructor(
    private readonly db: DB,
    private readonly now: () => Date,
  ) {}

  private async fetch(db: Executor, id: string) {
    const [row] = await db
      .select(cols)
      .from(products)
      .innerJoin(productCategories, eq(productCategories.id, products.categoryId))
      .where(eq(products.id, id));
    return row;
  }

  private async assertCategory(db: Executor, categoryId: string) {
    const [c] = await db.select({ id: productCategories.id }).from(productCategories).where(eq(productCategories.id, categoryId));
    if (!c) {
      throw unprocessable("CATEGORY_NOT_FOUND", "Kategori produk tidak ditemukan", [
        { field: "categoryId", message: "Kategori tidak ditemukan" },
      ]);
    }
  }

  async list(q: { categoryId?: string; isActive?: boolean; q?: string; page?: number; limit?: number }) {
    const p = toPage(q);
    const where: SQL[] = [];
    if (q.categoryId) where.push(eq(products.categoryId, q.categoryId));
    if (q.isActive !== undefined) where.push(eq(products.isActive, q.isActive));
    if (q.q?.trim()) {
      const pat = likePattern(q.q.trim());
      where.push(or(ilike(products.name, pat), ilike(products.sku, pat))!);
    }
    const cond = where.length ? and(...where) : undefined;
    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select(cols)
        .from(products)
        .innerJoin(productCategories, eq(productCategories.id, products.categoryId))
        .where(cond)
        .orderBy(asc(productCategories.sortOrder), asc(products.name), asc(products.id))
        .limit(p.limit)
        .offset(p.offset),
      this.db.select({ total: count() }).from(products).where(cond),
    ]);
    return { data: rows.map(toProductDto), meta: pageMeta(p, total) };
  }

  async get(id: string) {
    const row = await this.fetch(this.db, id);
    if (!row) throw notFound("Produk tidak ditemukan");
    return toProductDto(row);
  }

  async create(input: ProductInput, ctx: AuditContext) {
    return this.db.transaction(async (tx) => {
      await this.assertCategory(tx, input.categoryId);
      const [{ id }] = await tx
        .insert(products)
        .values({
          categoryId: input.categoryId,
          name: input.name.trim(),
          price: input.price,
          sku: normSku(input.sku) ?? null,
          description: input.description ?? null,
          isActive: input.isActive ?? true,
        })
        .returning({ id: products.id });
      const dto = toProductDto((await this.fetch(tx, id))!);
      await writeAudit(tx, { action: "product.created", entityType: "product", entityId: id, after: dto, ctx });
      return dto;
    });
  }

  async update(id: string, input: Partial<ProductInput>, ctx: AuditContext) {
    return this.db.transaction(async (tx) => {
      const [locked] = await tx.select({ id: products.id }).from(products).where(eq(products.id, id)).for("update");
      if (!locked) throw notFound("Produk tidak ditemukan");
      const before = toProductDto((await this.fetch(tx, id))!);
      if (input.categoryId) await this.assertCategory(tx, input.categoryId);
      await tx
        .update(products)
        .set({
          ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.price !== undefined ? { price: input.price } : {}),
          ...(input.sku !== undefined ? { sku: normSku(input.sku) } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          updatedAt: this.now(),
        })
        .where(eq(products.id, id));
      const after = toProductDto((await this.fetch(tx, id))!);
      await writeAudit(tx, { action: "product.updated", entityType: "product", entityId: id, before, after, ctx });
      return after;
    });
  }

  async remove(id: string, ctx: AuditContext) {
    await this.db.transaction(async (tx) => {
      const [locked] = await tx.select({ id: products.id }).from(products).where(eq(products.id, id)).for("update");
      if (!locked) throw notFound("Produk tidak ditemukan");
      const before = toProductDto((await this.fetch(tx, id))!);
      const used = await tx.execute(sql`select 1 from ${saleItems} where ${saleItems.productId} = ${id} limit 1`);
      if (used.length) throw conflict("PRODUCT_IN_USE", "Produk sudah pernah dijual, nonaktifkan saja");
      await tx.delete(products).where(eq(products.id, id));
      await writeAudit(tx, { action: "product.deleted", entityType: "product", entityId: id, before, ctx });
    });
  }
}
