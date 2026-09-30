import { Elysia, t } from "elysia";
import type { ModuleContext } from "../../app";
import { bearer, errorResponses, TAGS } from "../../plugins/openapi";
import { DateTimeString, IdParams, Uuid } from "../common";
import { ProductCategoryService } from "./service";

export const ProductCategorySchema = t.Object({
  id: Uuid,
  name: t.String(),
  sortOrder: t.Integer(),
  createdAt: DateTimeString,
  updatedAt: DateTimeString,
});

const CreateBody = t.Object({
  name: t.String({ minLength: 1, maxLength: 60, examples: ["Ayam"] }),
  sortOrder: t.Optional(t.Integer({ minimum: 0, maximum: 10_000 })),
});
const UpdateBody = t.Partial(CreateBody, { minProperties: 1 });

export function productCategoryRoutes(m: ModuleContext) {
  const svc = new ProductCategoryService(m.db, m.now);
  const tags = [TAGS.productCategories];

  return new Elysia({ prefix: "/product-categories" })
    .use(m.auth)
    .guard({ auth: true, detail: { security: bearer } })
    .get("", () => svc.list(), {
      response: { 200: t.Array(ProductCategorySchema), ...errorResponses },
      detail: { tags, summary: "Daftar kategori produk", description: "Urut `sortOrder`, lalu nama." },
    })
    .post(
      "",
      async ({ body, request, server, set }) => {
        const dto = await svc.create(body, m.auditCtx(request, server));
        set.status = 201;
        return dto;
      },
      { body: CreateBody, response: { 201: ProductCategorySchema, ...errorResponses }, detail: { tags, summary: "Buat kategori produk" } },
    )
    .patch("/:id", ({ params, body, request, server }) => svc.update(params.id, body, m.auditCtx(request, server)), {
      params: IdParams,
      body: UpdateBody,
      response: { 200: ProductCategorySchema, ...errorResponses },
      detail: { tags, summary: "Ubah kategori produk" },
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
        detail: { tags, summary: "Hapus kategori produk", description: "409 `CATEGORY_IN_USE` bila masih dipakai produk." },
      },
    );
}
