export function halfUp(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

export function pesos(p: number): number {
  return halfUp(p * 100);
}

export function formatC(c: number): string {
  const sign = c < 0 ? '-' : '';
  const abs = Math.abs(c);
  const whole = Math.floor(abs / 100).toLocaleString('en-PH');
  const cents = String(abs % 100).padStart(2, '0');
  return `${sign}${whole}.${cents}`;
}

export function formatPeso(c: number): string {
  return c < 0 ? `-₱${formatC(-c)}` : `₱${formatC(c)}`;
}

export function parsePesoInput(s: string): number | null {
  const cleaned = s.replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return halfUp(parseFloat(cleaned) * 100);
}

export function mulRate(c: number, rate: number): number {
  return halfUp(c * rate);
}

export function pct(c: number, percent: number): number {
  return halfUp((c * percent) / 100);
}

export function vatIncluded(totalC: number, rate: number): number {
  if (rate === 0) return 0;
  return halfUp((totalC * rate) / (1 + rate));
}
