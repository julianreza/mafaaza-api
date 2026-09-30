import { describe, expect, test } from "bun:test";
import { csvField, csvRow, csvStream, UTF8_BOM } from "../../src/lib/csv";

describe("csv", () => {
  test("escapes comma, quote and newline", () => {
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
    expect(csvField("plain")).toBe("plain");
    expect(csvField(null)).toBe("");
    expect(csvField(12000)).toBe("12000");
  });

  test("neutralises formula injection in strings but not numbers", () => {
    expect(csvField("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvField("+62812")).toBe("'+62812");
    expect(csvField("@cmd")).toBe("'@cmd");
    expect(csvField("-1+1")).toBe("'-1+1");
    expect(csvField(-5000)).toBe("-5000");
  });

  test("row uses CRLF", () => {
    expect(csvRow(["a", 1, null])).toBe("a,1,\r\n");
  });

  test("stream emits BOM, header and batches", async () => {
    async function* batches() {
      yield [["x", 1]];
      yield [];
      yield [["y", 2]];
    }
    const bytes = await new Response(csvStream(["name", "n"], batches())).arrayBuffer();
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    expect(text).toBe(`${UTF8_BOM}name,n\r\nx,1\r\ny,2\r\n`);
  });
});
