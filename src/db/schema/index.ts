import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  char,
  check,
  date,
  index,
  inet,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => tz("created_at").notNull().defaultNow();
const updatedAt = () => tz("updated_at").notNull().defaultNow();
const id = () => uuid("id").primaryKey().defaultRandom();

// ── Enums ────────────────────────────────────────────────────────────────
export const PAYMENT_METHODS = ["CASH", "QRIS", "TRANSFER", "EWALLET"] as const;
export const ORDER_TYPES = ["TAKE_AWAY", "ONLINE"] as const;
export const SALE_STATUSES = ["COMPLETED", "VOIDED"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type OrderType = (typeof ORDER_TYPES)[number];
export type SaleStatus = (typeof SALE_STATUSES)[number];

export const paymentMethodEnum = pgEnum("payment_method", PAYMENT_METHODS);
export const orderTypeEnum = pgEnum("order_type", ORDER_TYPES);
export const saleStatusEnum = pgEnum("sale_status", SALE_STATUSES);

// ── Admin & auth ─────────────────────────────────────────────────────────
export const admins = pgTable(
  "admins",
  {
    id: id(),
    name: varchar("name", { length: 100 }).notNull(),
    email: varchar("email", { length: 254 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    passwordChangedAt: tz("password_changed_at").notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("admins_email_lower_uq").on(sql`lower(${t.email})`)],
);

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: id(),
    adminId: uuid("admin_id")
      .notNull()
      .references(() => admins.id, { onDelete: "cascade" }),
    tokenHash: char("token_hash", { length: 64 }).notNull().unique("refresh_tokens_token_hash_unique"),
    expiresAt: tz("expires_at").notNull(),
    revokedAt: tz("revoked_at"),
    replacedBy: uuid("replaced_by").references((): AnyPgColumn => refreshTokens.id),
    userAgent: varchar("user_agent", { length: 255 }),
    ip: inet("ip"),
    createdAt: createdAt(),
  },
  (t) => [index("refresh_tokens_admin_idx").on(t.adminId)],
);

// ── Products ─────────────────────────────────────────────────────────────
export const productCategories = pgTable(
  "product_categories",
  {
    id: id(),
    name: varchar("name", { length: 60 }).notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("product_categories_name_lower_uq").on(sql`lower(${t.name})`)],
);

export const products = pgTable(
  "products",
  {
    id: id(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => productCategories.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 100 }).notNull(),
    sku: varchar("sku", { length: 40 }),
    description: text("description"),
    price: integer("price").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("products_sku_lower_uq").on(sql`lower(${t.sku})`).where(sql`${t.sku} IS NOT NULL`),
    index("products_category_idx").on(t.categoryId),
    index("products_active_idx").on(t.isActive),
    check("products_price_check", sql`${t.price} >= 0`),
  ],
);

// ── Sales ────────────────────────────────────────────────────────────────
export const sales = pgTable(
  "sales",
  {
    id: id(),
    receiptNo: varchar("receipt_no", { length: 20 }).notNull().unique("sales_receipt_no_unique"),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    soldAt: tz("sold_at").notNull(),
    orderType: orderTypeEnum("order_type").notNull().default("TAKE_AWAY"),
    paymentMethod: paymentMethodEnum("payment_method").notNull(),
    subtotal: integer("subtotal").notNull(),
    discount: integer("discount").notNull().default(0),
    total: integer("total").notNull(),
    cashReceived: integer("cash_received"),
    changeAmount: integer("change_amount"),
    note: varchar("note", { length: 255 }),
    status: saleStatusEnum("status").notNull().default("COMPLETED"),
    voidReason: varchar("void_reason", { length: 255 }),
    voidedAt: tz("voided_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("sales_business_date_status_idx").on(t.businessDate, t.status),
    index("sales_sold_at_idx").on(t.soldAt.desc()),
    index("sales_payment_method_idx").on(t.paymentMethod),
    check("sales_subtotal_check", sql`${t.subtotal} >= 0`),
    check("sales_discount_check", sql`${t.discount} >= 0 AND ${t.discount} <= ${t.subtotal}`),
    check("sales_total_check", sql`${t.total} = ${t.subtotal} - ${t.discount}`),
    check(
      "sales_cash_check",
      sql`${t.cashReceived} IS NULL OR (${t.paymentMethod} = 'CASH' AND ${t.cashReceived} >= ${t.total} AND ${t.changeAmount} = ${t.cashReceived} - ${t.total})`,
    ),
    check("sales_void_check", sql`(${t.status} = 'VOIDED') = (${t.voidedAt} IS NOT NULL)`),
  ],
);

export const saleItems = pgTable(
  "sale_items",
  {
    id: id(),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    productName: varchar("product_name", { length: 100 }).notNull(),
    categoryId: uuid("category_id").notNull(),
    categoryName: varchar("category_name", { length: 60 }).notNull(),
    unitPrice: integer("unit_price").notNull(),
    qty: integer("qty").notNull(),
    lineTotal: integer("line_total").notNull(),
    /** Order of the item in the original request (0-based). */
    position: integer("position").notNull().default(0),
  },
  (t) => [
    index("sale_items_sale_idx").on(t.saleId),
    index("sale_items_product_idx").on(t.productId),
    check("sale_items_unit_price_check", sql`${t.unitPrice} >= 0`),
    check("sale_items_qty_check", sql`${t.qty} >= 1`),
    check("sale_items_line_total_check", sql`${t.lineTotal} = ${t.unitPrice} * ${t.qty}`),
  ],
);

export const receiptCounters = pgTable("receipt_counters", {
  businessDate: date("business_date", { mode: "string" }).primaryKey(),
  lastSeq: integer("last_seq").notNull(),
});

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: varchar("key", { length: 100 }).primaryKey(),
  requestHash: char("request_hash", { length: 64 }).notNull(),
  saleId: uuid("sale_id")
    .notNull()
    .references(() => sales.id, { onDelete: "restrict" }),
  createdAt: createdAt(),
});

// ── Expenses ─────────────────────────────────────────────────────────────
export const expenseCategories = pgTable(
  "expense_categories",
  {
    id: id(),
    name: varchar("name", { length: 60 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("expense_categories_name_lower_uq").on(sql`lower(${t.name})`)],
);

export const expenses = pgTable(
  "expenses",
  {
    id: id(),
    expenseDate: date("expense_date", { mode: "string" }).notNull(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => expenseCategories.id, { onDelete: "restrict" }),
    amount: integer("amount").notNull(),
    paymentMethod: paymentMethodEnum("payment_method").notNull(),
    description: varchar("description", { length: 255 }).notNull(),
    vendor: varchar("vendor", { length: 100 }),
    attachmentPath: varchar("attachment_path", { length: 255 }),
    attachmentMime: varchar("attachment_mime", { length: 50 }),
    attachmentSize: integer("attachment_size"),
    deletedAt: tz("deleted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("expenses_date_idx").on(t.expenseDate).where(sql`${t.deletedAt} IS NULL`),
    index("expenses_category_idx").on(t.categoryId).where(sql`${t.deletedAt} IS NULL`),
    check("expenses_amount_check", sql`${t.amount} > 0`),
  ],
);

// ── Audit ────────────────────────────────────────────────────────────────
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    action: varchar("action", { length: 50 }).notNull(),
    entityType: varchar("entity_type", { length: 40 }).notNull(),
    entityId: varchar("entity_id", { length: 64 }),
    before: jsonb("before"),
    after: jsonb("after"),
    ip: inet("ip"),
    userAgent: varchar("user_agent", { length: 255 }),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_logs_created_at_idx").on(t.createdAt.desc()),
    index("audit_logs_entity_idx").on(t.entityType, t.entityId),
    index("audit_logs_action_idx").on(t.action),
  ],
);
