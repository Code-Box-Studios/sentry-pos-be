import { halfUp } from './money';

export function qtyToMilli(q: number): number {
  const m = q * 1000;
  const rounded = Math.round(m);
  if (Math.abs(m - rounded) > 1e-6)
    throw new Error(`quantity ${q} exceeds 3 decimal places`);
  return rounded;
}

export function milliToQty(m: number): number {
  return m / 1000;
}

export function formatQty(q: number, soldBy: 'unit' | 'weight'): string {
  return soldBy === 'weight' ? (qtyToMilli(q) / 1000).toFixed(3) : String(q);
}

export function mulQtyPriceC(qty: number, unitPriceC: number): number {
  return halfUp((qtyToMilli(qty) * unitPriceC) / 1000);
}
