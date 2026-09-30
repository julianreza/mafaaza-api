import { Elysia, t } from "elysia";
import type { ModuleContext } from "../../app";
import { PaginationQuery } from "../../lib/pagination";
import { bearer, errorResponses, TAGS } from "../../plugins/openapi";
import {
  DateRangeQuery,
  DateTimeString,
  IdParams,
  ListOf,
  Money,
  OrderTypeSchema,
  PaymentMethodSchema,
  SaleStatusSchema,
  Uuid,
} from "../common";
import { SaleService } from "./service";

const SaleSummaryFields = {
  id: Uuid,
  receiptNo: t.String({ examples: ["INV-20260929-0012"] }),
  businessDate: t.String(),
  soldAt: DateTimeString,
  orderType: OrderTypeSchema,
  paymentMethod: PaymentMethodSchema,
  subtotal: t.Integer(),
  discount: t.Integer(),
  total: t.Integer(),
  cashReceived: t.Nullable(t.Integer()),
  changeAmount: t.Nullable(t.Integer()),
  note: t.Nullable(t.String()),
  status: SaleStatusSchema,
  voidReason: t.Nullable(t.String()),
  voidedAt: t.Nullable(DateTimeString),
  createdAt: DateTimeString,
};

export const SaleSchema = t.Object({
  ...SaleSummaryFields,
  items: t.Array(
    t.Object({
      productId: Uuid,
      productName: t.String(),
      categoryId: Uuid,
      categoryName: t.String(),
      unitPrice: t.Integer(),
      qty: t.Integer(),
      lineTotal: t.Integer(),
    }),
  ),
});

const SaleListItem = t.Object({ ...SaleSummaryFields, itemCount: t.Integer() });

const CreateSaleBody = t.Object(
  {
    items: t.Array(t.Object({ productId: Uuid, qty: t.Integer({ minimum: 1, maximum: 999 }) }), {
      minItems: 1,
      maxItems: 100,
    }),
    paymentMethod: PaymentMethodSchema,
    orderType: t.Optional(OrderTypeSchema),
    discount: t.Optional(Money),
    cashReceived: t.Optional(t.Nullable(Money)),
    note: t.Optional(t.Nullable(t.String({ maxLength: 255 }))),
    soldAt: t.Optional(t.String({ format: "date-time", description: "Untuk input susulan; tidak boleh di masa depan" })),
  },
  {
    examples: [
      {
        items: [
          { productId: "7f3c2a8e-1b2c-4d5e-8f90-1a2b3c4d5e6f", qty: 2 },
          { productId: "a91e7b6c-5d4e-4f3a-9b2c-1d0e9f8a7b6c", qty: 1 },
        ],
        paymentMethod: "CASH",
        orderType: "TAKE_AWAY",
        discount: 2000,
        cashReceived: 50000,
        note: "tanpa sambal",
      },
    ],
  },
);

const CreateSaleHeaders = t.Object({
  "idempotency-key": t.Optional(t.String({ pattern: "^[A-Za-z0-9_-]{1,100}$" })),
});

const ListQuery = t.Object({
  ...DateRangeQuery,
  paymentMethod: t.Optional(PaymentMethodSchema),
  orderType: t.Optional(OrderTypeSchema),
  status: t.Optional(SaleStatusSchema),
  q: t.Optional(t.String({ maxLength: 30, description: "Cari nomor struk" })),
  ...PaginationQuery,
});

const VoidBody = t.Object({ reason: t.String({ minLength: 3, maxLength: 255 }) });

export function saleRoutes(m: ModuleContext) {
  const svc = new SaleService(m.db, m.now);
  const tags = [TAGS.sales];

  return new Elysia({ prefix: "/sales" })
    .use(m.auth)
    .guard({ auth: true, detail: { security: bearer } })
    .post(
      "",
      async ({ body, headers, request, server, set }) => {
        const { sale, replayed } = await svc.create(body, m.auditCtx(request, server), headers["idempotency-key"]);
        set.status = 201;
        if (replayed) set.headers["idempotent-replayed"] = "true";
        return sale;
      },
      {
        body: CreateSaleBody,
        headers: CreateSaleHeaders,
        response: { 201: SaleSchema, ...errorResponses },
        detail: {
          tags,
          summary: "Catat penjualan",
          description:
            "Harga diambil dari data produk saat ini (snapshot). Kirim header `Idempotency-Key` untuk mencegah transaksi ganda; replay dalam 24 jam mengembalikan penjualan yang sama dengan header `Idempotent-Replayed: true`.",
        },
      },
    )
    .get("", ({ query }) => svc.list(query), {
      query: ListQuery,
      response: { 200: ListOf(SaleListItem), ...errorResponses },
      detail: { tags, summary: "Daftar penjualan", description: "Urut terbaru lebih dulu. Filter tanggal = hari bisnis WIB." },
    })
    .get("/:id", ({ params }) => svc.get(params.id), {
      params: IdParams,
      response: { 200: SaleSchema, ...errorResponses },
      detail: { tags, summary: "Detail penjualan" },
    })
    .post("/:id/void", ({ params, body, request, server }) => svc.void(params.id, body.reason, m.auditCtx(request, server)), {
      params: IdParams,
      body: VoidBody,
      response: { 200: SaleSchema, ...errorResponses },
      detail: { tags, summary: "Batalkan (void) penjualan", description: "Data tidak dihapus; status menjadi VOIDED." },
    });
}
