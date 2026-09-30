import { t } from "elysia";
import { PASSWORD_MAX, PASSWORD_MIN } from "./service";

export const AdminProfileSchema = t.Object({
  id: t.String({ format: "uuid" }),
  name: t.String(),
  email: t.String(),
});

export const TokenPairSchema = t.Object({
  accessToken: t.String(),
  accessTokenExpiresAt: t.String({ format: "date-time" }),
  refreshToken: t.String(),
  refreshTokenExpiresAt: t.String({ format: "date-time" }),
});

export const LoginBody = t.Object({
  email: t.String({ minLength: 3, maxLength: 254, examples: ["admin@example.com"] }),
  password: t.String({ minLength: 1, maxLength: 200, examples: ["rahasia123"] }),
});

export const LoginResponse = t.Composite([TokenPairSchema, t.Object({ admin: AdminProfileSchema })], {
  examples: [
    {
      accessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIuLi4ifQ.signature",
      accessTokenExpiresAt: "2026-09-29T13:36:50.000Z",
      refreshToken: "Q2hhbmdlTWVUb0FSYW5kb21SZWZyZXNoVG9rZW4xMjM",
      refreshTokenExpiresAt: "2026-10-06T13:21:50.000Z",
      admin: { id: "5c1f2e3d-4b5a-4c6d-8e7f-9a0b1c2d3e4f", name: "Admin Toko", email: "admin@example.com" },
    },
  ],
});

export const RefreshBody = t.Object({ refreshToken: t.String({ minLength: 10, maxLength: 200 }) });

export const UpdateMeBody = t.Object(
  {
    name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
    email: t.Optional(t.String({ format: "email", maxLength: 254 })),
  },
  { minProperties: 1 },
);

export const ChangePasswordBody = t.Object({
  currentPassword: t.String({ minLength: 1, maxLength: 200 }),
  newPassword: t.String({ minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX }),
});
