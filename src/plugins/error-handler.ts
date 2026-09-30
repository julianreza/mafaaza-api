import { Elysia, ValidationError } from "elysia";
import { AppError, mapPgError, type ErrorDetail } from "../lib/errors";
import { logger } from "../lib/logger";
import { requestIdOf } from "./request-logger";

function body(code: string, message: string, details?: ErrorDetail[]) {
  return { error: details && details.length ? { code, message, details } : { code, message } };
}

function validationDetails(err: ValidationError): ErrorDetail[] {
  const seen = new Set<string>();
  const out: ErrorDetail[] = [];
  for (const e of err.all as Array<{ path?: string; message?: string; summary?: string }>) {
    const field = (e.path ?? "").replace(/^\//, "").replace(/\//g, ".") || "(body)";
    if (seen.has(field)) continue;
    seen.add(field);
    out.push({ field, message: e.summary ?? e.message ?? "Tidak valid" });
  }
  return out;
}

function json(status: number, payload: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/** Maps every error to `{ error: { code, message, details? } }` and adds security headers. */
export const errorHandler = new Elysia({ name: "error-handler" })
  .onAfterHandle({ as: "global" }, ({ set }) => {
    set.headers["x-content-type-options"] = "nosniff";
    set.headers["referrer-policy"] = "no-referrer";
    set.headers["x-frame-options"] = "DENY";
  })
  .onError({ as: "global" }, ({ code, error, request, set }) => {
    const reqId = requestIdOf(request);
    const base: Record<string, string> = {
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
    };
    if (reqId) base["x-request-id"] = reqId;
    const cors = set.headers["access-control-allow-origin"];
    if (typeof cors === "string") {
      base["access-control-allow-origin"] = cors;
      base.vary = "Origin";
    }

    if (error instanceof AppError) {
      return json(error.status, body(error.code, error.message, error.details), {
        ...base,
        ...(error.headers ?? {}),
      });
    }
    if (code === "VALIDATION" && error instanceof ValidationError) {
      return json(422, body("VALIDATION_ERROR", "Input tidak valid", validationDetails(error)), base);
    }
    if (code === "PARSE") {
      return json(422, body("INVALID_BODY", "Body request tidak dapat dibaca"), base);
    }
    if (code === "NOT_FOUND") {
      return json(404, body("NOT_FOUND", "Endpoint tidak ditemukan"), base);
    }
    const pg = mapPgError(error);
    if (pg) return json(pg.status, body(pg.code, pg.message), base);

    logger.error("unhandled error", {
      requestId: reqId,
      code: String(code),
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
    });
    return json(500, body("INTERNAL_ERROR", "Terjadi kesalahan pada server"), base);
  });
