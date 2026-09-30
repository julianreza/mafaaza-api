import { Elysia, t } from "elysia";
import type { ModuleContext } from "../../app";
import { PageMetaSchema, PaginationQuery } from "../../lib/pagination";
import { bearer, errorResponses, TAGS } from "../../plugins/openapi";
import { DateRangeQuery, DateString, DateTimeString, IdParams, PaymentMethodSchema, Uuid } from "../common";
import { ExpenseService } from "./service";

export const ExpenseSchema = t.Object({
  id: Uuid,
  expenseDate: t.String(),
  category: t.Object({ id: Uuid, name: t.String() }),
  amount: t.Integer(),
  paymentMethod: PaymentMethodSchema,
  description: t.String(),
  vendor: t.Nullable(t.String()),
  attachment: t.Nullable(t.Object({ mimeType: t.String(), size: t.Integer() })),
  createdAt: DateTimeString,
  updatedAt: DateTimeString,
});

const CreateBody = t.Object(
  {
    expenseDate: t.Optional(DateString),
    categoryId: Uuid,
    amount: t.Integer({ minimum: 1, maximum: 2_000_000_000 }),
    paymentMethod: PaymentMethodSchema,
    description: t.String({ minLength: 1, maxLength: 255 }),
    vendor: t.Optional(t.Nullable(t.String({ maxLength: 100 }))),
  },
  {
    examples: [
      {
        expenseDate: "2026-09-29",
        categoryId: "3b0f1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
        amount: 450000,
        paymentMethod: "CASH",
        description: "Ayam potong 15 kg",
        vendor: "Pak Slamet",
      },
    ],
  },
);
const UpdateBody = t.Partial(CreateBody, { minProperties: 1 });

const ListQuery = t.Object({
  ...DateRangeQuery,
  categoryId: t.Optional(Uuid),
  paymentMethod: t.Optional(PaymentMethodSchema),
  q: t.Optional(t.String({ maxLength: 100, description: "Cari deskripsi atau pemasok" })),
  ...PaginationQuery,
});

const ListResponse = t.Object({
  data: t.Array(ExpenseSchema),
  meta: t.Composite([PageMetaSchema, t.Object({ totalAmount: t.Integer() })]),
});

export function expenseRoutes(m: ModuleContext) {
  const svc = new ExpenseService(m.db, m.now, m.env.UPLOAD_DIR);
  const tags = [TAGS.expenses];

  return new Elysia({ prefix: "/expenses" })
    .use(m.auth)
    .guard({ auth: true, detail: { security: bearer } })
    .get("", ({ query }) => svc.list(query), {
      query: ListQuery,
      response: { 200: ListResponse, ...errorResponses },
      detail: { tags, summary: "Daftar pengeluaran", description: "`meta.totalAmount` = total nominal seluruh hasil filter." },
    })
    .get("/:id", ({ params }) => svc.get(params.id), {
      params: IdParams,
      response: { 200: ExpenseSchema, ...errorResponses },
      detail: { tags, summary: "Detail pengeluaran" },
    })
    .post(
      "",
      async ({ body, request, server, set }) => {
        const dto = await svc.create(body, m.auditCtx(request, server));
        set.status = 201;
        return dto;
      },
      {
        body: CreateBody,
        response: { 201: ExpenseSchema, ...errorResponses },
        detail: { tags, summary: "Catat pengeluaran", description: "`expenseDate` default hari ini (WIB), tidak boleh di masa depan." },
      },
    )
    .patch("/:id", ({ params, body, request, server }) => svc.update(params.id, body, m.auditCtx(request, server)), {
      params: IdParams,
      body: UpdateBody,
      response: { 200: ExpenseSchema, ...errorResponses },
      detail: { tags, summary: "Ubah pengeluaran" },
    })
    .delete(
      "/:id",
      async ({ params, request, server, set }) => {
        await svc.remove(params.id, m.auditCtx(request, server));
        set.status = 204;
      },
      {
        params: IdParams,
        response: { 204: t.Void(), ...errorResponses },
        detail: { tags, summary: "Hapus pengeluaran (soft-delete)" },
      },
    )
    .put("/:id/attachment", ({ params, body, request, server }) => svc.uploadAttachment(params.id, body.file, m.auditCtx(request, server)), {
      params: IdParams,
      body: t.Object({ file: t.File({ description: "JPEG, PNG, WEBP, atau PDF; maks 5 MB" }) }),
      response: { 200: ExpenseSchema, ...errorResponses },
      detail: { tags, summary: "Unggah bukti/nota pengeluaran", description: "Mengganti bukti sebelumnya bila ada." },
    })
    .get(
      "/:id/attachment",
      async ({ params }) => {
        const a = await svc.getAttachment(params.id);
        return new Response(a.file, {
          headers: {
            "content-type": a.mime,
            "content-disposition": `inline; filename="bukti-${params.id}.${a.ext}"`,
            "x-content-type-options": "nosniff",
            "cache-control": "private, no-store",
          },
        });
      },
      {
        params: IdParams,
        response: { 200: t.File({ description: "File bukti (image/jpeg, image/png, image/webp, application/pdf)" }), ...errorResponses },
        detail: {
          tags,
          summary: "Unduh bukti pengeluaran",
        },
      },
    )
    .delete(
      "/:id/attachment",
      async ({ params, request, server, set }) => {
        await svc.deleteAttachment(params.id, m.auditCtx(request, server));
        set.status = 204;
      },
      { params: IdParams, response: { 204: t.Void(), ...errorResponses }, detail: { tags, summary: "Hapus bukti pengeluaran" } },
    );
}
