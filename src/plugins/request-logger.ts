import { Elysia } from "elysia";
import { logger } from "../lib/logger";

const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

interface RequestMeta {
  id: string;
  start: number;
}

const meta = new WeakMap<Request, RequestMeta>();

export function requestIdOf(request: Request): string | undefined {
  return meta.get(request)?.id;
}

/** Assigns a request id, echoes it as X-Request-Id and logs one JSON line per request. */
export const requestLogger = new Elysia({ name: "request-logger" })
  .onRequest(({ request, set }) => {
    const incoming = request.headers.get("x-request-id");
    const id = incoming && REQUEST_ID_RE.test(incoming) ? incoming : crypto.randomUUID();
    meta.set(request, { id, start: performance.now() });
    set.headers["x-request-id"] = id;
  })
  .onAfterResponse({ as: "global" }, ({ request, set, path }) => {
    const m = meta.get(request);
    logger.info("request", {
      requestId: m?.id,
      method: request.method,
      path,
      status: typeof set.status === "number" ? set.status : 200,
      durationMs: m ? Math.round((performance.now() - m.start) * 100) / 100 : undefined,
    });
  });
