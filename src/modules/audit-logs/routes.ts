import { and, count, desc, eq, gte, lt, type SQL } from "drizzle-orm";
import { Elysia, t } from "elysia";
import type { ModuleContext } from "../../app";
import type { DB } from "../../db/client";
import { auditLogs } from "../../db/schema";
import { PaginationQuery, pageMeta, toPage } from "../../lib/pagination";
import { businessDayRangeUtc, parseDateRange } from "../../lib/time";
import { bearer, errorResponses, TAGS } from "../../plugins/openapi";
import { DateRangeQuery, DateTimeString, iso, ListOf } from "../common";

const AuditLogSchema = t.Object({
  id: t.Integer(),
  action: t.String({ examples: ["sale.voided"] }),
  entityType: t.String(),
  entityId: t.Nullable(t.String()),
  before: t.Unknown(),
  after: t.Unknown(),
  ip: t.Nullable(t.String()),
  userAgent: t.Nullable(t.String()),
  createdAt: DateTimeString,
});

const ListQuery = t.Object({
  ...DateRangeQuery,
  action: t.Optional(t.String({ maxLength: 50 })),
  entityType: t.Optional(t.String({ maxLength: 40 })),
  entityId: t.Optional(t.String({ maxLength: 64 })),
  ...PaginationQuery,
});

export class AuditLogService {
  constructor(
    private readonly db: DB,
    private readonly now: () => Date,
  ) {}

  async list(q: { from?: string; to?: string; action?: string; entityType?: string; entityId?: string; page?: number; limit?: number }) {
    const p = toPage(q);
    const where: SQL[] = [];
    if (q.from || q.to) {
      const r = parseDateRange(q.from, q.to, { now: this.now(), maxDays: 100_000 });
      where.push(gte(auditLogs.createdAt, businessDayRangeUtc(r.from).start));
      where.push(lt(auditLogs.createdAt, businessDayRangeUtc(r.to).end));
    }
    if (q.action) where.push(eq(auditLogs.action, q.action));
    if (q.entityType) where.push(eq(auditLogs.entityType, q.entityType));
    if (q.entityId) where.push(eq(auditLogs.entityId, q.entityId));
    const cond = where.length ? and(...where) : undefined;
    const [rows, [{ total }]] = await Promise.all([
      this.db.select().from(auditLogs).where(cond).orderBy(desc(auditLogs.id)).limit(p.limit).offset(p.offset),
      this.db.select({ total: count() }).from(auditLogs).where(cond),
    ]);
    return {
      data: rows.map((r) => ({
        id: r.id,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        before: r.before ?? null,
        after: r.after ?? null,
        ip: r.ip,
        userAgent: r.userAgent,
        createdAt: iso(r.createdAt)!,
      })),
      meta: pageMeta(p, total),
    };
  }
}

export function auditLogRoutes(m: ModuleContext) {
  const svc = new AuditLogService(m.db, m.now);
  return new Elysia({ prefix: "/audit-logs" })
    .use(m.auth)
    .guard({ auth: true, detail: { security: bearer } })
    .get("", ({ query }) => svc.list(query), {
      query: ListQuery,
      response: { 200: ListOf(AuditLogSchema), ...errorResponses },
      detail: {
        tags: [TAGS.audit],
        summary: "Riwayat perubahan (append-only)",
        description: "Terbaru lebih dulu. Filter tanggal = hari bisnis WIB. Tidak ada endpoint ubah/hapus.",
      },
    });
}
