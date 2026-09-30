import { t } from "elysia";
import { PageMetaSchema } from "../lib/pagination";

export const Uuid = t.String({ format: "uuid" });
export const IdParams = t.Object({ id: Uuid });
export const DateString = t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", examples: ["2026-09-29"] });
export const DateTimeString = t.String({ format: "date-time" });
export const Money = t.Integer({ minimum: 0, maximum: 2_000_000_000 });

export const DateRangeQuery = {
  from: t.Optional(DateString),
  to: t.Optional(DateString),
};

/** `{ data: T[], meta }` list envelope. */
export const ListOf = <T extends Parameters<typeof t.Array>[0]>(item: T) =>
  t.Object({ data: t.Array(item), meta: PageMetaSchema });

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Query-string boolean ("true"/"false"). */
export const BoolQuery = t.Union([t.Literal("true"), t.Literal("false")]);
export const parseBool = (v: "true" | "false" | undefined) => (v === undefined ? undefined : v === "true");

/**
 * String enums as unions of literals. (Elysia fills an omitted optional `t.UnionEnum`
 * with its first member, which would silently turn "no filter" into a filter.)
 */
export const PaymentMethodSchema = t.Union([
  t.Literal("CASH"),
  t.Literal("QRIS"),
  t.Literal("TRANSFER"),
  t.Literal("EWALLET"),
]);
export const OrderTypeSchema = t.Union([t.Literal("TAKE_AWAY"), t.Literal("ONLINE")]);
export const SaleStatusSchema = t.Union([t.Literal("COMPLETED"), t.Literal("VOIDED")]);
