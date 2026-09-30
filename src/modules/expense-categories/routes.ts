import { Elysia, t } from "elysia";
import type { ModuleContext } from "../../app";
import { bearer, errorResponses, TAGS } from "../../plugins/openapi";
import { BoolQuery, DateTimeString, IdParams, parseBool, Uuid } from "../common";
import { ExpenseCategoryService } from "./service";

export const ExpenseCategorySchema = t.Object({
  id: Uuid,
  name: t.String(),
  isActive: t.Boolean(),
  createdAt: DateTimeString,
  updatedAt: DateTimeString,
});

const CreateBody = t.Object({
  name: t.String({ minLength: 1, maxLength: 60, examples: ["Bahan Baku Ayam"] }),
  isActive: t.Optional(t.Boolean()),
});
const UpdateBody = t.Partial(CreateBody, { minProperties: 1 });

export function expenseCategoryRoutes(m: ModuleContext) {
  const svc = new ExpenseCategoryService(m.db, m.now);
  const tags = [TAGS.expenseCategories];

  return new Elysia({ prefix: "/expense-categories" })
    .use(m.auth)
    .guard({ auth: true, detail: { security: bearer } })
    .get("", ({ query }) => svc.list({ isActive: parseBool(query.isActive) }), {
      query: t.Object({ isActive: t.Optional(BoolQuery) }),
      response: { 200: t.Array(ExpenseCategorySchema), ...errorResponses },
      detail: { tags, summary: "Daftar kategori pengeluaran" },
    })
    .post(
      "",
      async ({ body, request, server, set }) => {
        const dto = await svc.create(body, m.auditCtx(request, server));
        set.status = 201;
        return dto;
      },
      { body: CreateBody, response: { 201: ExpenseCategorySchema, ...errorResponses }, detail: { tags, summary: "Buat kategori pengeluaran" } },
    )
    .patch("/:id", ({ params, body, request, server }) => svc.update(params.id, body, m.auditCtx(request, server)), {
      params: IdParams,
      body: UpdateBody,
      response: { 200: ExpenseCategorySchema, ...errorResponses },
      detail: { tags, summary: "Ubah / nonaktifkan kategori pengeluaran" },
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
        detail: { tags, summary: "Hapus kategori pengeluaran", description: "409 `CATEGORY_IN_USE` bila pernah dipakai." },
      },
    );
}
