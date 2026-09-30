import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import type { Env } from "./config/env";
import type { DB } from "./db/client";
import { auditContext, type AuditContext } from "./lib/audit";
import { authRoutes } from "./modules/auth/routes";
import { AuthService } from "./modules/auth/service";
import { healthRoutes } from "./modules/health/routes";
import { productCategoryRoutes } from "./modules/product-categories/routes";
import { productRoutes } from "./modules/products/routes";
import { saleRoutes } from "./modules/sales/routes";
import { expenseCategoryRoutes } from "./modules/expense-categories/routes";
import { expenseRoutes } from "./modules/expenses/routes";
import { reportRoutes } from "./modules/reports/routes";
import { exportRoutes } from "./modules/exports/routes";
import { auditLogRoutes } from "./modules/audit-logs/routes";
import { authPlugin, type AuthPlugin } from "./plugins/auth";
import { errorHandler } from "./plugins/error-handler";
import { openapiPlugin } from "./plugins/openapi";
import { requestLogger } from "./plugins/request-logger";

export interface AppDeps {
  db: DB;
  env: Env;
  /** Injectable clock for tests. */
  now?: () => Date;
}

type ServerLike = { requestIP(req: Request): { address: string } | null } | null;

/** Everything a module factory needs. */
export interface ModuleContext {
  db: DB;
  env: Env;
  now: () => Date;
  auth: AuthPlugin;
  authService: AuthService;
  auditCtx: (request: Request, server: ServerLike) => AuditContext;
}

export function createApp(deps: AppDeps) {
  const now = deps.now ?? (() => new Date());
  const authService = new AuthService(deps.db, deps.env, now);
  const m: ModuleContext = {
    db: deps.db,
    env: deps.env,
    now,
    authService,
    auth: authPlugin(authService),
    auditCtx: (request, server) => auditContext(request, server, deps.env.TRUST_PROXY),
  };

  const app = new Elysia()
    .use(requestLogger)
    .use(
      cors({
        origin: deps.env.CORS_ORIGINS,
        credentials: false,
        allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "X-Request-Id"],
        exposeHeaders: ["X-Request-Id", "Content-Disposition", "Idempotent-Replayed", "Retry-After"],
      }),
    )
    .use(errorHandler);

  if (deps.env.OPENAPI_ENABLED) app.use(openapiPlugin());

  const api = new Elysia({ prefix: "/api/v1" })
    .use(authRoutes(m))
    .use(productCategoryRoutes(m))
    .use(productRoutes(m))
    .use(saleRoutes(m))
    .use(expenseCategoryRoutes(m))
    .use(expenseRoutes(m))
    .use(reportRoutes(m))
    .use(exportRoutes(m))
    .use(auditLogRoutes(m));

  return Object.assign(app.use(healthRoutes(deps)).use(api), { services: { auth: authService } });
}

export type App = ReturnType<typeof createApp>;
