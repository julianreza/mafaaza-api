import { t } from "elysia";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/** Query schema fragment for paginated list endpoints. */
export const PaginationQuery = {
  page: t.Optional(t.Integer({ minimum: 1, default: 1 })),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT })),
};

export interface Page {
  page: number;
  limit: number;
  offset: number;
}

export function toPage(q: { page?: number; limit?: number }): Page {
  const page = Math.max(1, Math.floor(q.page ?? 1));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(q.limit ?? DEFAULT_LIMIT)));
  return { page, limit, offset: (page - 1) * limit };
}

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function pageMeta(p: Page, total: number): PageMeta {
  return { page: p.page, limit: p.limit, total, totalPages: Math.ceil(total / p.limit) };
}

export const PageMetaSchema = t.Object({
  page: t.Integer(),
  limit: t.Integer(),
  total: t.Integer(),
  totalPages: t.Integer(),
});

/** Escape LIKE wildcards so user input is matched literally. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
