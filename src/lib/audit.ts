import type { Executor } from "../db/client";
import { auditLogs } from "../db/schema";

export interface AuditContext {
  ip: string | null;
  userAgent: string | null;
}

export const NO_CONTEXT: AuditContext = { ip: null, userAgent: null };

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ctx: AuditContext;
}

const SENSITIVE_KEYS = new Set(
  [
    "password",
    "passwordHash",
    "password_hash",
    "currentPassword",
    "newPassword",
    "token",
    "refreshToken",
    "accessToken",
    "tokenHash",
    "token_hash",
  ].map((k) => k.toLowerCase()),
);

/** Deep-copies a value dropping any key that could carry a secret. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) continue;
      out[k] = redact(v);
    }
    return out;
  }
  return value;
}

/** Append an audit row inside the same transaction as the change it describes. */
export async function writeAudit(db: Executor, e: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId ?? null,
    before: e.before === undefined ? null : redact(e.before),
    after: e.after === undefined ? null : redact(e.after),
    ip: e.ctx.ip,
    userAgent: e.ctx.userAgent,
  });
}

/** Resolve client IP (honouring TRUST_PROXY) and user agent for audit/rate limiting. */
export function clientIp(
  request: Request,
  server: { requestIP(req: Request): { address: string } | null } | null | undefined,
  trustProxy: boolean,
): string | null {
  if (trustProxy) {
    const fwd = request.headers.get("x-forwarded-for");
    const first = fwd?.split(",")[0]?.trim();
    if (first && isIp(first)) return first;
  }
  const addr = server?.requestIP(request)?.address ?? null;
  return addr && isIp(addr) ? addr.replace(/^::ffff:/, "") : null;
}

function isIp(s: string): boolean {
  return /^[0-9.]+$/.test(s) || /^[0-9a-fA-F:.]+$/.test(s);
}

export function auditContext(
  request: Request,
  server: { requestIP(req: Request): { address: string } | null } | null | undefined,
  trustProxy: boolean,
): AuditContext {
  const ua = request.headers.get("user-agent");
  return { ip: clientIp(request, server, trustProxy), userAgent: ua ? ua.slice(0, 255) : null };
}
