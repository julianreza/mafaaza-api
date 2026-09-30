export interface ErrorDetail {
  field?: string;
  message?: string;
  [key: string]: unknown;
}

/** Business error thrown by services; mapped 1:1 to the API error envelope. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: ErrorDetail[],
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (message = "Data tidak ditemukan") => new AppError(404, "NOT_FOUND", message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const unprocessable = (code: string, message: string, details?: ErrorDetail[]) =>
  new AppError(422, code, message, details);
export const unauthorized = (code = "UNAUTHORIZED", message = "Autentikasi diperlukan") =>
  new AppError(401, code, message);

/** Unique-constraint name → user-facing 409 message. */
export const UNIQUE_CONSTRAINT_MESSAGES: Record<string, string> = {
  admins_email_lower_uq: "Email sudah dipakai",
  product_categories_name_lower_uq: "Nama kategori produk sudah dipakai",
  products_sku_lower_uq: "SKU sudah dipakai",
  expense_categories_name_lower_uq: "Nama kategori pengeluaran sudah dipakai",
  sales_receipt_no_unique: "Nomor struk bentrok, silakan ulangi",
};

interface PgLikeError {
  code?: string;
  constraint_name?: string;
  constraint?: string;
}

/** Extract a postgres.js error from an error chain (drizzle wraps driver errors in `cause`). */
export function findPgError(err: unknown): PgLikeError | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    const c = cur as PgLikeError & { cause?: unknown; name?: string };
    if (typeof c.code === "string" && /^[0-9A-Z]{5}$/.test(c.code)) return c;
    cur = c.cause;
  }
  return undefined;
}

export function mapPgError(err: unknown): AppError | undefined {
  const pg = findPgError(err);
  if (!pg) return undefined;
  const constraint = pg.constraint_name ?? pg.constraint ?? "";
  switch (pg.code) {
    case "23505":
      return new AppError(409, "CONFLICT", UNIQUE_CONSTRAINT_MESSAGES[constraint] ?? "Data sudah ada");
    case "23503":
      return new AppError(409, "IN_USE", "Data masih dipakai oleh data lain");
    case "23514":
      return new AppError(422, "INVALID_VALUE", "Nilai tidak memenuhi aturan data");
    default:
      return undefined;
  }
}
