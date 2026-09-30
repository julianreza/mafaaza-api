export type CsvValue = string | number | boolean | null | undefined;

const INJECTION_PREFIX = /^[=+\-@\t\r]/;

/** Escape one CSV field (RFC 4180) and neutralise spreadsheet formula injection. */
export function csvField(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  let s = typeof value === "string" ? value : String(value);
  if (typeof value === "string" && INJECTION_PREFIX.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function csvRow(values: CsvValue[]): string {
  return `${values.map(csvField).join(",")}\r\n`;
}

export const UTF8_BOM = "\uFEFF";

/**
 * Stream a CSV: BOM + header, then each batch yielded by `batches` (pulled lazily,
 * so only one batch is in memory at a time).
 */
export function csvStream(header: string[], batches: AsyncIterable<CsvValue[][]>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const it = batches[Symbol.asyncIterator]();
  let started = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(enc.encode(UTF8_BOM + csvRow(header)));
        return;
      }
      // Skip empty batches inside one pull: a pull that enqueues nothing may not be re-invoked.
      for (;;) {
        const { value, done } = await it.next();
        if (done) {
          controller.close();
          return;
        }
        if (value.length) {
          controller.enqueue(enc.encode(value.map(csvRow).join("")));
          return;
        }
      }
    },
    async cancel() {
      await it.return?.();
    },
  });
}
