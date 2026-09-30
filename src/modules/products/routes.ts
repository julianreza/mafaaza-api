import { Elysia, t } from "elysia";
import type { ModuleContext } from "../../app";
import { PaginationQuery } from "../../lib/pagination";
import { bearer, errorResponses, TAGS } from "../../plugins/openapi";
import { BoolQuery, DateTimeString, IdParams, ListOf, Money, parseBool, Uuid } from "../common";
import { ProductService } from "./service";

export const ProductSchema = t.Object({
  id: Uuid,
  name: t.String(),
  sku: t.Nullable(t.String()),
  description: t.Nullable(t.String()),
  price: t.Integer(),
  isActive: t.Boolean(),
  category: t.Object({ id: Uuid, name: t.String() }),
  createdAt: DateTimeString,
  updatedAt: DateTimeString,
});

const CreateBody = t.Object({
  categoryId: Uuid,
  name: t.String({ minLength: 1, maxLength: 100, examples: ["Paha Atas"] }),
  price: Money,
  sku: t.Optional(t.Nullable(t.String({ maxLength: 40, examples: ["AYM-PA"] }))),
  description: t.Optional(t.Nullable(t.String({ maxLength: 1000 }))),
  isActive: t.Optional(t.Boolean()),
});
const UpdateBody = t.Partial(CreateBody, { minProperties: 1 });

const ListQuery = t.Object({
  categoryId: t.Optional(Uuid),
  isActive: t.Optional(BoolQuery),
  q: t.Optional(t.String({ maxLength: 100, description: "Cari nama atau SKU" })),
  ...PaginationQuery,
});

export function productRoutes(m: ModuleContext) {
  const svc = new ProductService(m.db, m.now);
  const tags = [TAGS.products];

  return new Elysia({ prefix: "/products" })
    .use(m.auth)
    .guard({ auth: true, detail: { security: bearer } })
    .get("", ({ query }) => svc.list({ ...query, isActive: parseBool(query.isActive) }), {
      query: ListQuery,
      response: { 200: ListOf(ProductSchema), ...errorResponses },
      detail: { tags, summary: "Daftar produk (menu)" },
    })
    .get("/:id", ({ params }) => svc.get(params.id), {
      params: IdParams,
      response: { 200: ProductSchema, ...errorResponses },
      detail: { tags, summary: "Detail produk" },
    })
    .post(
      "",
      async ({ body, request, server, set }) => {
        const dto = await svc.create(body, m.auditCtx(request, server));
        set.status = 201;
        return dto;
      },
      { body: CreateBody, response: { 201: ProductSchema, ...errorResponses }, detail: { tags, summary: "Buat produk" } },
    )
    .patch("/:id", ({ params, body, request, server }) => svc.update(params.id, body, m.auditCtx(request, server)), {
      params: IdParams,
      body: UpdateBody,
      response: { 200: ProductSchema, ...errorResponses },
      detail: {
        tags,
        summary: "Ubah produk",
        description: "Perubahan harga hanya berlaku untuk penjualan berikutnya. Nonaktifkan dengan `isActive: false`.",
      },
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
        detail: { tags, summary: "Hapus produk", description: "409 `PRODUCT_IN_USE` bila pernah dijual." },
      },
    );
}
