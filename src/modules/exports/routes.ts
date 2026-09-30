import { Elysia, t } from "elysia";
import type { ModuleContext } from "../../app";
import { csvStream, type CsvValue } from "../../lib/csv";
import { parseDateRange, type DateRange } from "../../lib/time";
import { bearer, errorResponses, TAGS } from "../../plugins/openapi";
import { DateRangeQuery } from "../common";
import { EXPENSES_COLUMNS, ExportService, SALE_ITEMS_COLUMNS, SALES_COLUMNS } from "./service";

const csvResponse = (name: string, r: DateRange, header: string[], batches: AsyncIterable<CsvValue[][]>) =>
  new Response(csvStream(header, batches), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}_${r.from}_${r.to}.csv"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });

const csvDoc = (summary: string, columns: string[], extra: string) => ({
  tags: [TAGS.exports],
  summary,
  description: `CSV UTF-8 (dengan BOM), pemisah koma, baris CRLF. Rentang maks 366 hari (WIB). ${extra}\n\nKolom: \`${columns.join("`, `")}\``,
});

/** 200 = CSV text (the handler returns a streamed Response, which is not re-validated). */
const csvResponses = { 200: t.String({ description: "File CSV (text/csv; charset=utf-8)" }), ...errorResponses };

export function exportRoutes(m: ModuleContext) {
  const svc = new ExportService(m.db);
  const range = (q: { from?: string; to?: string }) => parseDateRange(q.from, q.to, { now: m.now() });
  const query = t.Object(DateRangeQuery);

  return new Elysia({ prefix: "/exports" })
    .use(m.auth)
    .guard({ auth: true, detail: { security: bearer } })
    .get(
      "/sales.csv",
      ({ query }) => {
        const r = range(query);
        return csvResponse("sales", r, SALES_COLUMNS, svc.sales(r));
      },
      {
        query,
        response: csvResponses,
        detail: csvDoc("Ekspor penjualan (CSV)", SALES_COLUMNS, "Penjualan VOIDED ikut disertakan dengan kolom status; `sold_at_wib` = waktu WIB."),
      },
    )
    .get(
      "/sale-items.csv",
      ({ query }) => {
        const r = range(query);
        return csvResponse("sale-items", r, SALE_ITEMS_COLUMNS, svc.saleItems(r));
      },
      { query, response: csvResponses, detail: csvDoc("Ekspor item penjualan (CSV)", SALE_ITEMS_COLUMNS, "") },
    )
    .get(
      "/expenses.csv",
      ({ query }) => {
        const r = range(query);
        return csvResponse("expenses", r, EXPENSES_COLUMNS, svc.expenses(r));
      },
      { query, response: csvResponses, detail: csvDoc("Ekspor pengeluaran (CSV)", EXPENSES_COLUMNS, "Pengeluaran yang dihapus tidak disertakan.") },
    );
}
