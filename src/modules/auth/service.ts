import { and, eq, isNull, sql } from "drizzle-orm";
import type { Env } from "../../config/env";
import type { DB, Executor } from "../../db/client";
import { admins, refreshTokens } from "../../db/schema";
import { writeAudit, type AuditContext } from "../../lib/audit";
import { AppError, unauthorized, unprocessable } from "../../lib/errors";
import { LoginRateLimiter } from "../../lib/rate-limit";
import { generateRefreshToken, sha256Hex, signAccessToken, verifyAccessToken } from "./tokens";

export interface AdminProfile {
  id: string;
  name: string;
  email: string;
}

export interface TokenPair {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

export interface LoginResult extends TokenPair {
  admin: AdminProfile;
}

const INVALID_CREDENTIALS = () => new AppError(401, "INVALID_CREDENTIALS", "Email atau password salah");
const INVALID_REFRESH = () => new AppError(401, "INVALID_REFRESH_TOKEN", "Refresh token tidak valid atau kedaluwarsa");
const CACHE_TTL_MS = 30_000;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 72;

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

/** Revoke every active refresh token of an admin. */
export async function revokeAllRefreshTokens(db: Executor, adminId: string, at: Date): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: at })
    .where(and(eq(refreshTokens.adminId, adminId), isNull(refreshTokens.revokedAt)));
}

export class AuthService {
  readonly limiter: LoginRateLimiter;
  /** Unique per instance; used as the Elysia plugin seed. */
  readonly instanceId = crypto.randomUUID();
  private dummyHash?: Promise<string>;
  private readonly cache = new Map<string, { admin: AdminProfile & { pwv: number }; exp: number }>();

  constructor(
    private readonly db: DB,
    private readonly env: Env,
    private readonly now: () => Date,
    limiter?: LoginRateLimiter,
  ) {
    this.limiter = limiter ?? new LoginRateLimiter({ now: () => this.now().getTime() });
  }

  private profile(a: typeof admins.$inferSelect): AdminProfile {
    return { id: a.id, name: a.name, email: a.email };
  }

  private async issueTokens(db: Executor, admin: typeof admins.$inferSelect, ctx: AuditContext) {
    const now = this.now();
    const access = await signAccessToken(this.env, { sub: admin.id, pwv: admin.passwordChangedAt.getTime() }, now);
    const refreshToken = generateRefreshToken();
    const refreshExpires = new Date(now.getTime() + this.env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
    const [row] = await db
      .insert(refreshTokens)
      .values({
        adminId: admin.id,
        tokenHash: sha256Hex(refreshToken),
        expiresAt: refreshExpires,
        userAgent: ctx.userAgent,
        ip: ctx.ip,
        createdAt: now,
      })
      .returning({ id: refreshTokens.id });
    const pair: TokenPair = {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken,
      refreshTokenExpiresAt: refreshExpires.toISOString(),
    };
    return { pair, refreshId: row.id };
  }

  async login(email: string, password: string, ctx: AuditContext): Promise<LoginResult> {
    const key = ctx.ip ?? "unknown";
    const retry = this.limiter.retryAfter(key);
    if (retry > 0) {
      throw new AppError(
        429,
        "TOO_MANY_ATTEMPTS",
        "Terlalu banyak percobaan login. Coba lagi nanti.",
        undefined,
        { "retry-after": String(retry) },
      );
    }

    const [admin] = await this.db
      .select()
      .from(admins)
      .where(sql`lower(${admins.email}) = lower(${email.trim()})`)
      .limit(1);

    let ok = false;
    if (admin) {
      ok = await Bun.password.verify(password, admin.passwordHash);
    } else {
      this.dummyHash ??= hashPassword("dummy-password-for-timing");
      await Bun.password.verify(password, await this.dummyHash);
    }

    if (!admin || !ok) {
      this.limiter.recordFailure(key);
      await writeAudit(this.db, {
        action: "auth.login_failed",
        entityType: "auth",
        entityId: admin?.id ?? null,
        after: { email: email.slice(0, 254) },
        ctx,
      });
      throw INVALID_CREDENTIALS();
    }

    this.limiter.recordSuccess(key);
    return this.db.transaction(async (tx) => {
      const { pair } = await this.issueTokens(tx, admin, ctx);
      await writeAudit(tx, { action: "auth.login_success", entityType: "auth", entityId: admin.id, ctx });
      return { ...pair, admin: this.profile(admin) };
    });
  }

  async refresh(refreshToken: string, ctx: AuditContext): Promise<TokenPair> {
    const now = this.now();
    const outcome = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, sha256Hex(refreshToken)))
        .for("update")
        .limit(1);
      if (!row || row.expiresAt.getTime() <= now.getTime()) return { kind: "invalid" as const };
      if (row.revokedAt) {
        await revokeAllRefreshTokens(tx, row.adminId, now);
        await writeAudit(tx, {
          action: "auth.refresh_reuse_detected",
          entityType: "auth",
          entityId: row.adminId,
          ctx,
        });
        return { kind: "reused" as const };
      }
      const [admin] = await tx.select().from(admins).where(eq(admins.id, row.adminId)).limit(1);
      if (!admin) return { kind: "invalid" as const };
      const { pair, refreshId } = await this.issueTokens(tx, admin, ctx);
      await tx
        .update(refreshTokens)
        .set({ revokedAt: now, replacedBy: refreshId })
        .where(eq(refreshTokens.id, row.id));
      return { kind: "ok" as const, pair };
    });
    // Reuse revocation must be committed before rejecting, hence throwing outside the transaction.
    if (outcome.kind !== "ok") throw INVALID_REFRESH();
    return outcome.pair;
  }

  async logout(refreshToken: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: this.now() })
      .where(and(eq(refreshTokens.tokenHash, sha256Hex(refreshToken)), isNull(refreshTokens.revokedAt)));
  }

  /** Validate a bearer header and return the admin; throws 401. */
  async authenticate(authorization: string | undefined | null): Promise<AdminProfile> {
    const m = authorization?.match(/^Bearer\s+(\S+)$/i);
    if (!m) throw unauthorized();
    const claims = await verifyAccessToken(this.env, m[1], this.now());
    if (!claims) throw unauthorized("INVALID_TOKEN", "Token tidak valid atau kedaluwarsa");

    const nowMs = this.now().getTime();
    let cached = this.cache.get(claims.sub);
    if (!cached || cached.exp <= nowMs) {
      const [a] = await this.db.select().from(admins).where(eq(admins.id, claims.sub)).limit(1);
      if (!a) throw unauthorized("INVALID_TOKEN", "Token tidak valid atau kedaluwarsa");
      cached = { admin: { ...this.profile(a), pwv: a.passwordChangedAt.getTime() }, exp: nowMs + CACHE_TTL_MS };
      this.cache.set(claims.sub, cached);
    }
    if (cached.admin.pwv !== claims.pwv) throw unauthorized("INVALID_TOKEN", "Token tidak valid atau kedaluwarsa");
    const { pwv: _pwv, ...profile } = cached.admin;
    return profile;
  }

  async getMe(adminId: string): Promise<AdminProfile> {
    const [a] = await this.db.select().from(admins).where(eq(admins.id, adminId)).limit(1);
    if (!a) throw unauthorized();
    return this.profile(a);
  }

  async updateMe(adminId: string, patch: { name?: string; email?: string }, ctx: AuditContext) {
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(admins).where(eq(admins.id, adminId)).for("update").limit(1);
      if (!before) throw unauthorized();
      const values: Partial<typeof admins.$inferInsert> = { updatedAt: this.now() };
      if (patch.name !== undefined) values.name = patch.name.trim();
      if (patch.email !== undefined) values.email = patch.email.trim();
      const [after] = await tx.update(admins).set(values).where(eq(admins.id, adminId)).returning();
      await writeAudit(tx, {
        action: "admin.profile_updated",
        entityType: "admin",
        entityId: adminId,
        before: { name: before.name, email: before.email },
        after: { name: after.name, email: after.email },
        ctx,
      });
      this.cache.delete(adminId);
      return this.profile(after);
    });
  }

  async changePassword(adminId: string, current: string, next: string, ctx: AuditContext): Promise<void> {
    const [a] = await this.db.select().from(admins).where(eq(admins.id, adminId)).limit(1);
    if (!a) throw unauthorized();
    if (!(await Bun.password.verify(current, a.passwordHash))) {
      throw unprocessable("INVALID_CURRENT_PASSWORD", "Password lama salah", [
        { field: "currentPassword", message: "Password lama salah" },
      ]);
    }
    if (current === next) {
      throw unprocessable("PASSWORD_UNCHANGED", "Password baru harus berbeda dari password lama", [
        { field: "newPassword", message: "Harus berbeda dari password lama" },
      ]);
    }
    await setPassword(this.db, adminId, next, this.now(), {
      action: "admin.password_changed",
      ctx,
    });
    this.cache.delete(adminId);
  }
}

/** Set a new password, bump the password version and revoke all sessions (used by API and CLI). */
export async function setPassword(
  db: DB,
  adminId: string,
  password: string,
  now: Date,
  audit: { action: string; ctx: AuditContext },
): Promise<void> {
  const passwordHash = await hashPassword(password);
  await db.transaction(async (tx) => {
    await tx
      .update(admins)
      .set({ passwordHash, passwordChangedAt: now, updatedAt: now })
      .where(eq(admins.id, adminId));
    await revokeAllRefreshTokens(tx, adminId, now);
    await writeAudit(tx, { action: audit.action, entityType: "admin", entityId: adminId, ctx: audit.ctx });
  });
}
