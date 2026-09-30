import { describe, expect, test } from "bun:test";
import { computeTotals, formatReceiptNo, mergeItems, priceItems } from "../../src/lib/money";

const prices: Record<string, number> = { a: 13000, b: 5000 };
const priced = priceItems(
  [
    { productId: "a", qty: 2 },
    { productId: "b", qty: 1 },
  ],
  (id) => prices[id],
);

describe("money", () => {
  test("line totals and subtotal/total", () => {
    expect(priced.map((i) => i.lineTotal)).toEqual([26000, 5000]);
    expect(computeTotals(priced, { discount: 1000, paymentMethod: "QRIS" })).toEqual({
      subtotal: 31000,
      discount: 1000,
      total: 30000,
      cashReceived: null,
      changeAmount: null,
    });
  });

  test("discount equal to subtotal is allowed (total 0)", () => {
    expect(computeTotals(priced, { discount: 31000, paymentMethod: "QRIS" }).total).toBe(0);
  });

  test("discount above subtotal or negative is rejected", () => {
    expect(() => computeTotals(priced, { discount: 31001, paymentMethod: "QRIS" })).toThrow(/Diskon/);
    expect(() => computeTotals(priced, { discount: -1, paymentMethod: "QRIS" })).toThrow(/Diskon/);
  });

  test("cash: change computed, exact cash gives 0, short cash rejected", () => {
    expect(computeTotals(priced, { paymentMethod: "CASH", cashReceived: 50000 })).toMatchObject({ changeAmount: 19000 });
    expect(computeTotals(priced, { paymentMethod: "CASH", cashReceived: 31000 })).toMatchObject({ changeAmount: 0 });
    expect(() => computeTotals(priced, { paymentMethod: "CASH", cashReceived: 30999 })).toThrow(/kurang/);
    expect(() => computeTotals(priced, { paymentMethod: "QRIS", cashReceived: 50000 })).toThrow(/tunai/);
  });

  test("duplicate items are merged", () => {
    expect(
      mergeItems([
        { productId: "a", qty: 1 },
        { productId: "b", qty: 2 },
        { productId: "a", qty: 3 },
      ]),
    ).toEqual([
      { productId: "a", qty: 4 },
      { productId: "b", qty: 2 },
    ]);
  });

  test("receipt number format", () => {
    expect(formatReceiptNo("2026-09-29", 12)).toBe("INV-20260929-0012");
    expect(formatReceiptNo("2026-09-29", 12345)).toBe("INV-20260929-12345");
  });
});
