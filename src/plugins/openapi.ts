import { openapi } from "@elysiajs/openapi";
import { t } from "elysia";

export const ErrorResponse = t.Object(
  {
    error: t.Object({
      code: t.String({ examples: ["VALIDATION_ERROR"] }),
      message: t.String({ examples: ["Input tidak valid"] }),
      details: t.Optional(t.Array(t.Record(t.String(), t.Unknown()))),
    }),
  },
  { $id: "#/components/schemas/ErrorResponse", title: "ErrorResponse" },
);

/** Standard error responses attached to every route's `response`. */
export const errorResponses = {
  401: ErrorResponse,
  404: ErrorResponse,
  409: ErrorResponse,
  422: ErrorResponse,
  429: ErrorResponse,
  500: ErrorResponse,
} as const;

export const TAGS = {
  health: "Health",
  auth: "Auth",
  productCategories: "Product Categories",
  products: "Products",
  sales: "Sales",
  expenseCategories: "Expense Categories",
  expenses: "Expenses",
  reports: "Reports",
  exports: "Exports",
  audit: "Audit Logs",
} as const;

export const bearer = [{ bearerAuth: [] as string[] }];

export function openapiPlugin() {
  return openapi({
    path: "/openapi",
    specPath: "/openapi/json",
    // CSV export routes end in ".csv"; do not treat them as static files.
    exclude: { staticFile: false },
    documentation: {
      info: {
        title: "Mafaaza API — Admin Dashboard Toko Fried Chicken",
        version: "1.0.0",
        description:
          "REST API untuk mencatat penjualan, pengeluaran, dan laporan. Nominal dalam Rupiah (integer), timestamp ISO 8601 UTC, parameter tanggal `YYYY-MM-DD` ditafsirkan sebagai hari bisnis WIB (Asia/Jakarta).",
      },
      tags: Object.values(TAGS).map((name) => ({ name })),
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
    },
  });
}
