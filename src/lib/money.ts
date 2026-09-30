import { AppError } from "./errors";

export interface ItemInput {
  productId: string;
  qty: number;
}

export interface PricedItem extends ItemInput {
  unitPrice: number;
  lineTotal: number;
}

export interface SaleTotals {
  subtotal: number;
  discount: number;
  total: number;
  cashReceived: number | null;
  changeAmount: number | null;
}

/** Merge duplicate productIds (summing qty), preserving first-seen order. */
export function mergeItems(items: ItemInput[]): ItemInput[] {
  const map = new Map<string, number>();
  for (const it of items) map.set(it.productId, (map.get(it.productId) ?? 0) + it.qty);
  return [...map].map(([productId, qty]) => ({ productId, qty }));
}

export function priceItems(items: ItemInput[], priceOf: (productId: string) => number): PricedItem[] {
  return items.map((it) => {
    const unitPrice = priceOf(it.productId);
    return { ...it, unitPrice, lineTotal: unitPrice * it.qty };
  });
}

/** subtotal = Σ lineTotal; total = subtotal − discount; change = cash − total. */
export function computeTotals(
  items: Pick<PricedItem, "lineTotal">[],
  opts: { discount?: number; paymentMethod: string; cashReceived?: number | null },
): SaleTotals {
  const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
  const discount = opts.discount ?? 0;
  if (!Number.isInteger(discount) || discount < 0 || discount > subtotal) {
    throw new AppError(422, "INVALID_DISCOUNT", "Diskon tidak boleh negatif atau melebihi subtotal", [
      { field: "discount", message: `Maksimal ${subtotal}` },
    ]);
  }
  const total = subtotal - discount;
  let cashReceived: number | null = null;
  let changeAmount: number | null = null;
  if (opts.cashReceived !== undefined && opts.cashReceived !== null) {
    if (opts.paymentMethod !== "CASH") {
      throw new AppError(422, "VALIDATION_ERROR", "Nominal diterima hanya untuk pembayaran tunai", [
        { field: "cashReceived", message: "Hanya untuk paymentMethod CASH" },
      ]);
    }
    if (opts.cashReceived < total) {
      throw new AppError(422, "INSUFFICIENT_CASH", "Nominal diterima kurang dari total", [
        { field: "cashReceived", message: `Minimal ${total}` },
      ]);
    }
    cashReceived = opts.cashReceived;
    changeAmount = cashReceived - total;
  }
  return { subtotal, discount, total, cashReceived, changeAmount };
}

export function formatReceiptNo(businessDate: string, seq: number): string {
  return `INV-${businessDate.replaceAll("-", "")}-${String(seq).padStart(4, "0")}`;
}
