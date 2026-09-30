import { Elysia, t } from "elysia";
import type { ModuleContext } from "../../app";
import { bearer, errorResponses, TAGS } from "../../plugins/openapi";
import { AdminProfileSchema, ChangePasswordBody, LoginBody, LoginResponse, RefreshBody, TokenPairSchema, UpdateMeBody } from "./model";

export function authRoutes(m: ModuleContext) {
  const svc = m.authService;
  const tags = [TAGS.auth];

  const publicRoutes = new Elysia({ prefix: "/auth" })
    .post("/login", ({ body, request, server }) => svc.login(body.email, body.password, m.auditCtx(request, server)), {
      body: LoginBody,
      response: { 200: LoginResponse, ...errorResponses },
      detail: {
        tags,
        summary: "Login admin",
        description: "Mengembalikan access token (15 menit) dan refresh token (7 hari). 5 kali gagal per IP dalam 15 menit → 429.",
      },
    })
    .post("/refresh", ({ body, request, server }) => svc.refresh(body.refreshToken, m.auditCtx(request, server)), {
      body: RefreshBody,
      response: { 200: TokenPairSchema, ...errorResponses },
      detail: { tags, summary: "Rotasi refresh token", description: "Refresh token lama langsung dibatalkan." },
    });

  const privateRoutes = new Elysia({ prefix: "/auth" })
    .use(m.auth)
    .guard({ auth: true, detail: { security: bearer } })
    .post(
      "/logout",
      async ({ body, set }) => {
        await svc.logout(body.refreshToken);
        set.status = 204;
      },
      {
        body: RefreshBody,
        response: { 204: t.Void(), ...errorResponses },
        detail: { tags, summary: "Logout (batalkan refresh token)" },
      },
    )
    .get("/me", ({ admin }) => svc.getMe(admin.id), {
      response: { 200: AdminProfileSchema, ...errorResponses },
      detail: { tags, summary: "Profil admin" },
    })
    .patch("/me", ({ admin, body, request, server }) => svc.updateMe(admin.id, body, m.auditCtx(request, server)), {
      body: UpdateMeBody,
      response: { 200: AdminProfileSchema, ...errorResponses },
      detail: { tags, summary: "Ubah nama/email admin" },
    })
    .post(
      "/change-password",
      async ({ admin, body, request, server, set }) => {
        await svc.changePassword(admin.id, body.currentPassword, body.newPassword, m.auditCtx(request, server));
        set.status = 204;
      },
      {
        body: ChangePasswordBody,
        response: { 204: t.Void(), ...errorResponses },
        detail: { tags, summary: "Ganti password", description: "Semua sesi (refresh token) dibatalkan." },
      },
    );

  return new Elysia().use(publicRoutes).use(privateRoutes);
}
