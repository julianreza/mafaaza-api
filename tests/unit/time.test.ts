import { describe, expect, test } from "bun:test";
import { toPage } from "../../src/lib/pagination";
import {
  businessDayRangeUtc,
  formatWib,
  parseDateRange,
  previousPeriod,
  toBusinessDate,
} from "../../src/lib/time";

describe("time", () => {
  test("business date switches at 17:00 UTC (midnight WIB)", () => {
    expect(toBusinessDate(new Date("2026-09-29T16:59:59Z"))).toBe("2026-09-29");
    expect(toBusinessDate(new Date("2026-09-29T17:00:00Z"))).toBe("2026-09-30");
  });

  test("business day range in UTC", () => {
    const r = businessDayRangeUtc("2026-09-30");
    expect(r.start.toISOString()).toBe("2026-09-29T17:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-09-30T17:00:00.000Z");
  });

  test("defaults to today", () => {
    const now = new Date("2026-09-29T20:00:00Z"); // 30 Sep WIB
    expect(parseDateRange(undefined, undefined, { now })).toEqual({ from: "2026-09-30", to: "2026-09-30" });
  });

  test("from > to rejected", () => {
    expect(() => parseDateRange("2026-09-02", "2026-09-01")).toThrow(/tidak boleh/);
  });

  test("367 days rejected, 366 accepted", () => {
    expect(() => parseDateRange("2025-01-01", "2026-01-02")).toThrow(/maksimal 366/);
    expect(parseDateRange("2025-01-01", "2026-01-01")).toEqual({ from: "2025-01-01", to: "2026-01-01" });
  });

  test("invalid date rejected", () => {
    expect(() => parseDateRange("2026-02-30", "2026-03-01")).toThrow(/YYYY-MM-DD/);
  });

  test("previous period of 7 days", () => {
    expect(previousPeriod({ from: "2026-09-08", to: "2026-09-14" })).toEqual({
      from: "2026-09-01",
      to: "2026-09-07",
    });
  });

  test("formatWib", () => {
    expect(formatWib(new Date("2026-09-29T17:30:05Z"))).toBe("2026-09-30 00:30:05");
  });
});

describe("pagination", () => {
  test("defaults and clamping", () => {
    expect(toPage({})).toEqual({ page: 1, limit: 20, offset: 0 });
    expect(toPage({ page: 3, limit: 500 })).toEqual({ page: 3, limit: 100, offset: 200 });
  });
});
