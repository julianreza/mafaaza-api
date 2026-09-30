import { sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import type { AppDeps } from "../../app";
import { TAGS } from "../../plugins/openapi";

export function healthRoutes(deps: AppDeps) {
  return new Elysia().get(
    "/health",
    async ({ set }) => {
      try {
        await deps.db.execute(sql`SELECT 1`);
        return { status: "ok" as const, db: "ok" as const };
      } catch {
        set.status = 503;
        return { status: "degraded" as const, db: "down" as const };
      }
    },
    {
      detail: { tags: [TAGS.health], summary: "Status aplikasi dan konektivitas database" },
      response: {
        200: t.Object({ status: t.Literal("ok"), db: t.Literal("ok") }),
        503: t.Object({ status: t.Literal("degraded"), db: t.Literal("down") }),
      },
    },
  );
}
