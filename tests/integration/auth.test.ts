import { beforeEach, describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
import { auditLogs, refreshTokens } from "../../src/db/schema";
import { resetAdminPassword } from "../../src/scripts/reset-password";
import {
  ADMIN,
  call,
  createTestApp,
  getTestDb,
  loginAsAdmin,
  nextIp,
  resetDb,
  seedAdmin,
  TEST_DATABASE_URL,
  type TestApp,
} from "../helpers";

let app: TestApp;

beforeEach(async () => {
  await resetDb();
  await seedAdmin();
  app = await createTestApp();
});

const login = (body: unknown, ip = nextIp()) =>
  call(app, "POST", "/api/v1/auth/login", { body, headers: { "x-forwarded-for": ip, "user-agent": "bun-test" } });

describe("login", () => {
  test("correct credentials return tokens and profile without hash", async () => {
    const res = await login({ email: "ADMIN@toko.test", password: ADMIN.password });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeString();
    expect(res.body.refreshToken).toHaveLength(43);
    expect(res.body.admin).toEqual({ id: expect.any(String), name: ADMIN.name, email: ADMIN.email });
    expect(res.text).not.toContain("passwordHash");
    const expiresIn = Date.parse(res.body.accessTokenExpiresAt) - Date.now();
    expect(expiresIn).toBeGreaterThan(890_000);
    expect(expiresIn).toBeLessThanOrEqual(900_000);
  });

  test("unknown email and wrong password give the same generic 401", async () => {
    const a = await login({ email: "nobody@toko.test", password: ADMIN.password });
    const b = await login({ email: ADMIN.email, password: "wrong-password" });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);
    expect(a.body.error.message).toBe("Email atau password salah");
  });

  test("5 failures from one IP → 429 with Retry-After, even with the right password", async () => {
    const ip = nextIp();
    for (let i = 0; i < 5; i++) expect((await login({ email: ADMIN.email, password: "bad" }, ip)).status).toBe(401);
    const locked = await login({ email: ADMIN.email, password: ADMIN.password }, ip);
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe("TOO_MANY_ATTEMPTS");
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    // other IPs unaffected
    expect((await login({ email: ADMIN.email, password: ADMIN.password })).status).toBe(200);
  });

  test("malformed JSON body → 422 INVALID_BODY", async () => {
    const res = await call(app, "POST", "/api/v1/auth/login", { body: "{not json" });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("INVALID_BODY");
  });

  test("schema violation → 422 with field details", async () => {
    const res = await login({ email: "a@b.c" });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain("password");
  });

  test("audit entries for success and failure", async () => {
    await login({ email: ADMIN.email, password: "bad" });
    await login({ email: ADMIN.email, password: ADMIN.password });
    const { db } = await getTestDb();
    const rows = await db.select().from(auditLogs).orderBy(auditLogs.id);
    expect(rows.map((r) => r.action)).toEqual(["auth.login_failed", "auth.login_success"]);
    expect(rows[0].userAgent).toBe("bun-test");
    expect(rows[0].ip).toBeTruthy();
    expect(JSON.stringify(rows)).not.toContain("bad");
  });
});

describe("refresh / logout", () => {
  test("rotation: new pair works, old refresh token is rejected", async () => {
    const { refreshToken } = await loginAsAdmin(app);
    const r1 = await call(app, "POST", "/api/v1/auth/refresh", { body: { refreshToken } });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(refreshToken);
    const me = await call(app, "GET", "/api/v1/auth/me", { token: r1.body.accessToken });
    expect(me.status).toBe(200);
  });

  test("reuse of a rotated token revokes every session", async () => {
    const { refreshToken } = await loginAsAdmin(app);
    const r1 = await call(app, "POST", "/api/v1/auth/refresh", { body: { refreshToken } });
    const reuse = await call(app, "POST", "/api/v1/auth/refresh", { body: { refreshToken } });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe("INVALID_REFRESH_TOKEN");
    const newer = await call(app, "POST", "/api/v1/auth/refresh", { body: { refreshToken: r1.body.refreshToken } });
    expect(newer.status).toBe(401);
    const { db } = await getTestDb();
    const [last] = await db.select().from(auditLogs).orderBy(desc(auditLogs.id)).limit(1);
    expect(last.action).toBe("auth.refresh_reuse_detected");
  });

  test("unknown or expired refresh token → 401", async () => {
    expect((await call(app, "POST", "/api/v1/auth/refresh", { body: { refreshToken: "x".repeat(43) } })).status).toBe(401);
    const { refreshToken } = await loginAsAdmin(app);
    const { db } = await getTestDb();
    await db.update(refreshTokens).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await call(app, "POST", "/api/v1/auth/refresh", { body: { refreshToken } })).status).toBe(401);
  });

  test("logout revokes the refresh token and is idempotent", async () => {
    const { token, refreshToken } = await loginAsAdmin(app);
    const out = await call(app, "POST", "/api/v1/auth/logout", { token, body: { refreshToken } });
    expect(out.status).toBe(204);
    expect((await call(app, "POST", "/api/v1/auth/logout", { token, body: { refreshToken } })).status).toBe(204);
    expect((await call(app, "POST", "/api/v1/auth/refresh", { body: { refreshToken } })).status).toBe(401);
  });
});

describe("profile & password", () => {
  test("GET/PATCH me", async () => {
    const { token } = await loginAsAdmin(app);
    const upd = await call(app, "PATCH", "/api/v1/auth/me", { token, body: { name: "Pak Budi" } });
    expect(upd.status).toBe(200);
    expect(upd.body.name).toBe("Pak Budi");
    const bad = await call(app, "PATCH", "/api/v1/auth/me", { token, body: { email: "not-an-email" } });
    expect(bad.status).toBe(422);
    const me = await call(app, "GET", "/api/v1/auth/me", { token });
    expect(me.body).toEqual({ id: expect.any(String), name: "Pak Budi", email: ADMIN.email });
  });

  test("change password invalidates old access and refresh tokens", async () => {
    const { token, refreshToken } = await loginAsAdmin(app);
    const wrong = await call(app, "POST", "/api/v1/auth/change-password", {
      token,
      body: { currentPassword: "nope", newPassword: "password-baru-1" },
    });
    expect(wrong.status).toBe(422);
    const short = await call(app, "POST", "/api/v1/auth/change-password", {
      token,
      body: { currentPassword: ADMIN.password, newPassword: "short" },
    });
    expect(short.status).toBe(422);
    const ok = await call(app, "POST", "/api/v1/auth/change-password", {
      token,
      body: { currentPassword: ADMIN.password, newPassword: "password-baru-1" },
    });
    expect(ok.status).toBe(204);
    expect((await call(app, "GET", "/api/v1/auth/me", { token })).status).toBe(401);
    expect((await call(app, "POST", "/api/v1/auth/refresh", { body: { refreshToken } })).status).toBe(401);
    expect((await login({ email: ADMIN.email, password: "password-baru-1" })).status).toBe(200);
    const { db } = await getTestDb();
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.action, "admin.password_changed"));
    expect(rows.length).toBe(1);
    expect(JSON.stringify(rows)).not.toContain("password-baru-1");
  });

  test("no user-creation endpoint exists", async () => {
    const { token } = await loginAsAdmin(app);
    expect((await call(app, "POST", "/api/v1/users", { token, body: {} })).status).toBe(404);
    expect((await call(app, "POST", "/api/v1/auth/register", { body: {} })).status).toBe(404);
  });

  test("CLI reset-password sets a new password and revokes sessions", async () => {
    const { refreshToken } = await loginAsAdmin(app);
    const email = await resetAdminPassword(TEST_DATABASE_URL, "dari-cli-123");
    expect(email).toBe(ADMIN.email);
    expect((await call(app, "POST", "/api/v1/auth/refresh", { body: { refreshToken } })).status).toBe(401);
    expect((await login({ email: ADMIN.email, password: "dari-cli-123" })).status).toBe(200);
    await expect(resetAdminPassword(TEST_DATABASE_URL, "short")).rejects.toThrow(/8-72/);
  });

  test("missing/invalid bearer → 401", async () => {
    expect((await call(app, "GET", "/api/v1/auth/me")).status).toBe(401);
    expect((await call(app, "GET", "/api/v1/auth/me", { token: "garbage" })).status).toBe(401);
  });
});
