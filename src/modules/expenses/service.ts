import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { and, count, desc, eq, gte, ilike, isNull, lte, or, sum, type SQL } from "drizzle-orm";
import type { DB, Executor } from "../../db/client";
import { expenseCategories, expenses, type PaymentMethod } from "../../db/schema";
import { writeAudit, type AuditContext } from "../../lib/audit";
import { notFound, unprocessable } from "../../lib/errors";
import { likePattern, pageMeta, toPage } from "../../lib/pagination";
import { isValidDate, todayBusinessDate } from "../../lib/time";
import { iso } from "../common";

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export interface ExpenseInput {
  expenseDate?: string;
  categoryId: string;
  amount: number;
  paymentMethod: PaymentMethod;
  description: string;
  vendor?: string | null;
}

export interface ExpenseListQuery {
  from?: string;
  to?: string;
  categoryId?: string;
  paymentMethod?: PaymentMethod;
  q?: string;
  page?: number;
  limit?: number;
}

const cols = {
  id: expenses.id,
  expenseDate: expenses.expenseDate,
  categoryId: expenses.categoryId,
  categoryName: expenseCategories.name,
  amount: expenses.amount,
  paymentMethod: expenses.paymentMethod,
  description: expenses.description,
  vendor: expenses.vendor,
  attachmentPath: expenses.attachmentPath,
  attachmentMime: expenses.attachmentMime,
  attachmentSize: expenses.attachmentSize,
  createdAt: expenses.createdAt,
  updatedAt: expenses.updatedAt,
};

type Joined = {
  id: string;
  expenseDate: string;
  categoryId: string;
  categoryName: string;
  amount: number;
  paymentMethod: PaymentMethod;
  description: string;
  vendor: string | null;
  attachmentPath: string | null;
  attachmentMime: string | null;
  attachmentSize: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export const toExpenseDto = (r: Joined) => ({
  id: r.id,
  expenseDate: r.expenseDate,
  category: { id: r.categoryId, name: r.categoryName },
  amount: r.amount,
  paymentMethod: r.paymentMethod,
  description: r.description,
  vendor: r.vendor,
  attachment: r.attachmentPath ? { mimeType: r.attachmentMime!, size: r.attachmentSize! } : null,
  createdAt: iso(r.createdAt)!,
  updatedAt: iso(r.updatedAt)!,
});

const SIGNATURES: { mime: string; ext: string; test: (b: Uint8Array) => boolean }[] = [
  { mime: "image/jpeg", ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", ext: "png", test: (b) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v) },
  {
    mime: "image/webp",
    ext: "webp",
    test: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP",
  },
  { mime: "application/pdf", ext: "pdf", test: (b) => ascii(b, 0, 5) === "%PDF-" },
];

function ascii(b: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...b.subarray(start, end));
}

/** Detect the real file type from its magic bytes (client-declared type is ignored). */
export function sniffFileType(head: Uint8Array): { mime: string; ext: string } | undefined {
  const s = SIGNATURES.find((sig) => sig.test(head));
  return s ? { mime: s.mime, ext: s.ext } : undefined;
}

export class ExpenseService {
  constructor(
    private readonly db: DB,
    private readonly now: () => Date,
    private readonly uploadDir: string,
  ) {}

  private async fetch(db: Executor, id: string): Promise<Joined | undefined> {
    const [row] = await db
      .select(cols)
      .from(expenses)
      .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
      .where(and(eq(expenses.id, id), isNull(expenses.deletedAt)));
    return row;
  }

  private async lock(db: Executor, id: string) {
    const [row] = await db
      .select({ id: expenses.id })
      .from(expenses)
      .where(and(eq(expenses.id, id), isNull(expenses.deletedAt)))
      .for("update");
    if (!row) throw notFound("Pengeluaran tidak ditemukan");
  }

  private validateDate(date: string) {
    if (!isValidDate(date)) {
      throw unprocessable("VALIDATION_ERROR", "Format tanggal harus YYYY-MM-DD", [
        { field: "expenseDate", message: "Format YYYY-MM-DD" },
      ]);
    }
    if (date > todayBusinessDate(this.now())) {
      throw unprocessable("EXPENSE_DATE_IN_FUTURE", "Tanggal pengeluaran tidak boleh di masa depan", [
        { field: "expenseDate", message: "Tidak boleh di masa depan" },
      ]);
    }
  }

  private async assertActiveCategory(db: Executor, categoryId: string) {
    const [c] = await db.select().from(expenseCategories).where(eq(expenseCategories.id, categoryId));
    if (!c) {
      throw unprocessable("CATEGORY_NOT_FOUND", "Kategori pengeluaran tidak ditemukan", [
        { field: "categoryId", message: "Tidak ditemukan" },
      ]);
    }
    if (!c.isActive) {
      throw unprocessable("CATEGORY_INACTIVE", "Kategori pengeluaran sudah nonaktif", [
        { field: "categoryId", message: "Kategori nonaktif" },
      ]);
    }
  }

  async list(q: ExpenseListQuery) {
    const p = toPage(q);
    for (const [field, d] of [
      ["from", q.from],
      ["to", q.to],
    ] as const) {
      if (d && !isValidDate(d)) {
        throw unprocessable("VALIDATION_ERROR", "Format tanggal harus YYYY-MM-DD", [{ field, message: "YYYY-MM-DD" }]);
      }
    }
    const where: SQL[] = [isNull(expenses.deletedAt)];
    if (q.from) where.push(gte(expenses.expenseDate, q.from));
    if (q.to) where.push(lte(expenses.expenseDate, q.to));
    if (q.categoryId) where.push(eq(expenses.categoryId, q.categoryId));
    if (q.paymentMethod) where.push(eq(expenses.paymentMethod, q.paymentMethod));
    if (q.q?.trim()) {
      const pat = likePattern(q.q.trim());
      where.push(or(ilike(expenses.description, pat), ilike(expenses.vendor, pat))!);
    }
    const cond = and(...where);
    const [rows, [agg]] = await Promise.all([
      this.db
        .select(cols)
        .from(expenses)
        .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
        .where(cond)
        .orderBy(desc(expenses.expenseDate), desc(expenses.createdAt), desc(expenses.id))
        .limit(p.limit)
        .offset(p.offset),
      this.db
        .select({ total: count(), totalAmount: sum(expenses.amount).mapWith(Number) })
        .from(expenses)
        .where(cond),
    ]);
    return {
      data: rows.map(toExpenseDto),
      meta: { ...pageMeta(p, agg.total), totalAmount: agg.totalAmount ?? 0 },
    };
  }

  async get(id: string) {
    const row = await this.fetch(this.db, id);
    if (!row) throw notFound("Pengeluaran tidak ditemukan");
    return toExpenseDto(row);
  }

  async create(input: ExpenseInput, ctx: AuditContext) {
    const expenseDate = input.expenseDate ?? todayBusinessDate(this.now());
    this.validateDate(expenseDate);
    return this.db.transaction(async (tx) => {
      await this.assertActiveCategory(tx, input.categoryId);
      const now = this.now();
      const [{ id }] = await tx
        .insert(expenses)
        .values({
          expenseDate,
          categoryId: input.categoryId,
          amount: input.amount,
          paymentMethod: input.paymentMethod,
          description: input.description.trim(),
          vendor: input.vendor?.trim() || null,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: expenses.id });
      const dto = toExpenseDto((await this.fetch(tx, id))!);
      await writeAudit(tx, { action: "expense.created", entityType: "expense", entityId: id, after: dto, ctx });
      return dto;
    });
  }

  async update(id: string, input: Partial<ExpenseInput>, ctx: AuditContext) {
    if (input.expenseDate !== undefined) this.validateDate(input.expenseDate);
    return this.db.transaction(async (tx) => {
      await this.lock(tx, id);
      const before = toExpenseDto((await this.fetch(tx, id))!);
      if (input.categoryId !== undefined && input.categoryId !== before.category.id) {
        await this.assertActiveCategory(tx, input.categoryId);
      }
      await tx
        .update(expenses)
        .set({
          ...(input.expenseDate !== undefined ? { expenseDate: input.expenseDate } : {}),
          ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
          ...(input.amount !== undefined ? { amount: input.amount } : {}),
          ...(input.paymentMethod !== undefined ? { paymentMethod: input.paymentMethod } : {}),
          ...(input.description !== undefined ? { description: input.description.trim() } : {}),
          ...(input.vendor !== undefined ? { vendor: input.vendor?.trim() || null } : {}),
          updatedAt: this.now(),
        })
        .where(eq(expenses.id, id));
      const after = toExpenseDto((await this.fetch(tx, id))!);
      await writeAudit(tx, { action: "expense.updated", entityType: "expense", entityId: id, before, after, ctx });
      return after;
    });
  }

  async remove(id: string, ctx: AuditContext) {
    await this.db.transaction(async (tx) => {
      await this.lock(tx, id);
      const before = toExpenseDto((await this.fetch(tx, id))!);
      await tx.update(expenses).set({ deletedAt: this.now() }).where(eq(expenses.id, id));
      await writeAudit(tx, { action: "expense.deleted", entityType: "expense", entityId: id, before, ctx });
    });
  }

  async uploadAttachment(id: string, file: File, ctx: AuditContext) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw unprocessable("FILE_TOO_LARGE", "Ukuran file maksimal 5 MB", [{ field: "file", message: "Maksimal 5 MB" }]);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = sniffFileType(bytes.subarray(0, 16));
    if (!kind) {
      throw unprocessable("UNSUPPORTED_FILE_TYPE", "Format file harus JPEG, PNG, WEBP, atau PDF", [
        { field: "file", message: "JPEG, PNG, WEBP, atau PDF" },
      ]);
    }
    return this.db.transaction(async (tx) => {
      await this.lock(tx, id);
      const relative = join("expenses", id, `${crypto.randomUUID()}.${kind.ext}`);
      const absolute = resolve(this.uploadDir, relative);
      await mkdir(resolve(this.uploadDir, "expenses", id), { recursive: true });
      await Bun.write(absolute, bytes);
      await tx
        .update(expenses)
        .set({ attachmentPath: relative, attachmentMime: kind.mime, attachmentSize: file.size, updatedAt: this.now() })
        .where(eq(expenses.id, id));
      await writeAudit(tx, {
        action: "expense.attachment_uploaded",
        entityType: "expense",
        entityId: id,
        after: { mimeType: kind.mime, size: file.size },
        ctx,
      });
      return toExpenseDto((await this.fetch(tx, id))!);
    });
  }

  async getAttachment(id: string): Promise<{ file: ReturnType<typeof Bun.file>; mime: string; ext: string }> {
    const row = await this.fetch(this.db, id);
    if (!row) throw notFound("Pengeluaran tidak ditemukan");
    if (!row.attachmentPath) throw notFound("Bukti pengeluaran tidak ditemukan");
    const file = Bun.file(resolve(this.uploadDir, row.attachmentPath));
    if (!(await file.exists())) throw notFound("File bukti tidak ditemukan di penyimpanan");
    return { file, mime: row.attachmentMime!, ext: row.attachmentPath.split(".").pop()! };
  }

  async deleteAttachment(id: string, ctx: AuditContext) {
    await this.db.transaction(async (tx) => {
      await this.lock(tx, id);
      const [row] = await tx.select({ path: expenses.attachmentPath }).from(expenses).where(eq(expenses.id, id));
      if (!row.path) throw notFound("Bukti pengeluaran tidak ditemukan");
      await tx
        .update(expenses)
        .set({ attachmentPath: null, attachmentMime: null, attachmentSize: null, updatedAt: this.now() })
        .where(eq(expenses.id, id));
      await writeAudit(tx, { action: "expense.attachment_deleted", entityType: "expense", entityId: id, ctx });
    });
  }
}
