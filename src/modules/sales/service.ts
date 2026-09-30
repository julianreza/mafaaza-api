import { and, asc, count, desc, eq, gte, ilike, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { DB, Executor } from "../../db/client";
import {
  idempotencyKeys,
  productCategories,
  products,
  receiptCounters,
  saleItems,
  sales,
  type OrderType,
  type PaymentMethod,
  type SaleStatus,
} from "../../db/schema";
import { writeAudit, type AuditContext } from "../../lib/audit";
import { AppError, conflict, findPgError, notFound, unprocessable } from "../../lib/errors";
import { computeTotals, formatReceiptNo, mergeItems, priceItems } from "../../lib/money";
import { likePattern, pageMeta, toPage } from "../../lib/pagination";
import { isValidDate, toBusinessDate } from "../../lib/time";
import { iso } from "../common";
import { sha256Hex } from "../auth/tokens";

export interface CreateSaleInput {
  items: { productId: string; qty: number }[];
  paymentMethod: PaymentMethod;
  orderType?: OrderType;
  discount?: number;
  cashReceived?: number | null;
  note?: string | null;
  soldAt?: string;
}

export interface SaleListQuery {
  from?: string;
  to?: string;
  paymentMethod?: PaymentMethod;
  orderType?: OrderType;
  status?: SaleStatus;
  q?: string;
  page?: number;
  limit?: number;
}

type SaleRow = typeof sales.$inferSelect;
type ItemRow = typeof saleItems.$inferSelect;

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 60_000;

export const toSaleSummaryDto = (s: SaleRow) => ({
  id: s.id,
  receiptNo: s.receiptNo,
  businessDate: s.businessDate,
  soldAt: iso(s.soldAt)!,
  orderType: s.orderType,
  paymentMethod: s.paymentMethod,
  subtotal: s.subtotal,
  discount: s.discount,
  total: s.total,
  cashReceived: s.cashReceived,
  changeAmount: s.changeAmount,
  note: s.note,
  status: s.status,
  voidReason: s.voidReason,
  voidedAt: iso(s.voidedAt),
  createdAt: iso(s.createdAt)!,
});

export const toSaleDto = (s: SaleRow, items: ItemRow[]) => ({
  ...toSaleSummaryDto(s),
  items: items.map((i) => ({
    productId: i.productId,
    productName: i.productName,
    categoryId: i.categoryId,
    categoryName: i.categoryName,
    unitPrice: i.unitPrice,
    qty: i.qty,
    lineTotal: i.lineTotal,
  })),
});

export type SaleDto = ReturnType<typeof toSaleDto>;

/** Stable JSON (sorted keys) for request hashing. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export class SaleService {
  constructor(
    private readonly db: DB,
    private readonly now: () => Date,
  ) {}

  async getById(db: Executor, id: string): Promise<SaleDto | undefined> {
    const [s] = await db.select().from(sales).where(eq(sales.id, id));
    if (!s) return undefined;
    const items = await db.select().from(saleItems).where(eq(saleItems.saleId, id)).orderBy(asc(saleItems.position));
    return toSaleDto(s, items);
  }

  async get(id: string): Promise<SaleDto> {
    const dto = await this.getById(this.db, id);
    if (!dto) throw notFound("Penjualan tidak ditemukan");
    return dto;
  }

  /**
   * Create a sale atomically. With an idempotency key, a replay within 24h returns the stored sale
   * (`replayed: true`); the same key with a different body is a 409.
   */
  async create(
    input: CreateSaleInput,
    ctx: AuditContext,
    idempotencyKey?: string,
  ): Promise<{ sale: SaleDto; replayed: boolean }> {
    const requestHash = idempotencyKey ? sha256Hex(canonicalJson(input)) : undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.createOnce(input, ctx, idempotencyKey, requestHash);
      } catch (e) {
        const pg = findPgError(e);
        const keyRace = pg?.code === "23505" && (pg.constraint_name ?? "").startsWith("idempotency_keys");
        if (keyRace && attempt === 0) continue; // concurrent twin committed first: re-read it
        throw e;
      }
    }
  }

  private async createOnce(
    input: CreateSaleInput,
    ctx: AuditContext,
    idempotencyKey: string | undefined,
    requestHash: string | undefined,
  ): Promise<{ sale: SaleDto; replayed: boolean }> {
    const now = this.now();
    return this.db.transaction(async (tx) => {
      if (idempotencyKey) {
        const [existing] = await tx.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, idempotencyKey));
        if (existing) {
          if (now.getTime() - existing.createdAt.getTime() < IDEMPOTENCY_TTL_MS) {
            if (existing.requestHash !== requestHash) {
              throw conflict("IDEMPOTENCY_KEY_REUSED", "Idempotency-Key sudah dipakai untuk request berbeda");
            }
            return { sale: (await this.getById(tx, existing.saleId))!, replayed: true };
          }
          await tx.delete(idempotencyKeys).where(eq(idempotencyKeys.key, idempotencyKey));
        }
      }

      const soldAt = input.soldAt ? new Date(input.soldAt) : now;
      if (Number.isNaN(soldAt.getTime())) {
        throw unprocessable("VALIDATION_ERROR", "Format soldAt tidak valid", [{ field: "soldAt", message: "ISO 8601" }]);
      }
      if (soldAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
        throw unprocessable("SOLD_AT_IN_FUTURE", "Waktu penjualan tidak boleh di masa depan", [
          { field: "soldAt", message: "Tidak boleh di masa depan" },
        ]);
      }

      const items = mergeItems(input.items);
      const ids = items.map((i) => i.productId);
      const rows = await tx
        .select({
          id: products.id,
          name: products.name,
          price: products.price,
          isActive: products.isActive,
          categoryId: productCategories.id,
          categoryName: productCategories.name,
        })
        .from(products)
        .innerJoin(productCategories, eq(productCategories.id, products.categoryId))
        .where(inArray(products.id, ids));
      const byId = new Map(rows.map((r) => [r.id, r]));
      const problems = ids.flatMap((id) => {
        const p = byId.get(id);
        if (!p) return [{ productId: id, reason: "not_found" }];
        if (!p.isActive) return [{ productId: id, reason: "inactive" }];
        return [];
      });
      if (problems.length) {
        throw new AppError(422, "PRODUCT_UNAVAILABLE", "Ada produk yang tidak tersedia", problems);
      }

      const priced = priceItems(items, (id) => byId.get(id)!.price);
      const totals = computeTotals(priced, {
        discount: input.discount,
        paymentMethod: input.paymentMethod,
        cashReceived: input.cashReceived,
      });

      const businessDate = toBusinessDate(soldAt);
      const [{ seq }] = await tx
        .insert(receiptCounters)
        .values({ businessDate, lastSeq: 1 })
        .onConflictDoUpdate({ target: receiptCounters.businessDate, set: { lastSeq: sql`${receiptCounters.lastSeq} + 1` } })
        .returning({ seq: receiptCounters.lastSeq });

      const [sale] = await tx
        .insert(sales)
        .values({
          receiptNo: formatReceiptNo(businessDate, seq),
          businessDate,
          soldAt,
          orderType: input.orderType ?? "TAKE_AWAY",
          paymentMethod: input.paymentMethod,
          ...totals,
          note: input.note?.trim() || null,
          createdAt: now,
        })
        .returning();

      const itemRows = await tx
        .insert(saleItems)
        .values(
          priced.map((it, position) => {
            const p = byId.get(it.productId)!;
            return {
              saleId: sale.id,
              productId: it.productId,
              productName: p.name,
              categoryId: p.categoryId,
              categoryName: p.categoryName,
              unitPrice: it.unitPrice,
              qty: it.qty,
              lineTotal: it.lineTotal,
              position,
            };
          }),
        )
        .returning();

      if (idempotencyKey) {
        await tx.insert(idempotencyKeys).values({ key: idempotencyKey, requestHash: requestHash!, saleId: sale.id, createdAt: now });
      }

      await writeAudit(tx, {
        action: "sale.created",
        entityType: "sale",
        entityId: sale.id,
        after: {
          receiptNo: sale.receiptNo,
          total: sale.total,
          paymentMethod: sale.paymentMethod,
          orderType: sale.orderType,
          itemCount: itemRows.length,
        },
        ctx,
      });

      itemRows.sort((a, b) => a.position - b.position);
      return { sale: toSaleDto(sale, itemRows), replayed: false };
    });
  }

  async list(q: SaleListQuery) {
    const p = toPage(q);
    const where: SQL[] = [];
    if (q.from) where.push(gte(sales.businessDate, q.from));
    if (q.to) where.push(lte(sales.businessDate, q.to));
    if (q.paymentMethod) where.push(eq(sales.paymentMethod, q.paymentMethod));
    if (q.orderType) where.push(eq(sales.orderType, q.orderType));
    if (q.status) where.push(eq(sales.status, q.status));
    if (q.q?.trim()) where.push(ilike(sales.receiptNo, likePattern(q.q.trim())));
    for (const d of [q.from, q.to]) {
      if (d && !isValidDate(d)) throw unprocessable("VALIDATION_ERROR", "Format tanggal harus YYYY-MM-DD");
    }
    const cond = where.length ? and(...where) : undefined;
    // Explicit qualifiers: drizzle drops table prefixes inside single-table selects.
    const itemCount = sql<number>`(select count(*)::int from sale_items si where si.sale_id = "sales"."id")`;
    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select({ sale: sales, itemCount })
        .from(sales)
        .where(cond)
        .orderBy(desc(sales.soldAt), desc(sales.id))
        .limit(p.limit)
        .offset(p.offset),
      this.db.select({ total: count() }).from(sales).where(cond),
    ]);
    return {
      data: rows.map((r) => ({ ...toSaleSummaryDto(r.sale), itemCount: Number(r.itemCount) })),
      meta: pageMeta(p, total),
    };
  }

  async void(id: string, reason: string, ctx: AuditContext): Promise<SaleDto> {
    return this.db.transaction(async (tx) => {
      const [s] = await tx.select().from(sales).where(eq(sales.id, id)).for("update");
      if (!s) throw notFound("Penjualan tidak ditemukan");
      if (s.status === "VOIDED") throw conflict("ALREADY_VOIDED", "Penjualan sudah dibatalkan");
      await tx
        .update(sales)
        .set({ status: "VOIDED", voidReason: reason.trim(), voidedAt: this.now() })
        .where(eq(sales.id, id));
      await writeAudit(tx, {
        action: "sale.voided",
        entityType: "sale",
        entityId: id,
        before: { status: s.status },
        after: { status: "VOIDED", reason: reason.trim() },
        ctx,
      });
      return (await this.getById(tx, id))!;
    });
  }
}
