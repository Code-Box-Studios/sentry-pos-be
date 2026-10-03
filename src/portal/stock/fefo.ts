/** Estimate remaining quantities without mutating receipt batches. Inputs must
 * belong to ONE branch; callers prove tenant scope before loading them.
 * Unbatched positive adjustments remain unassigned; historical unknown-branch
 * batches must never be included in a branch projection. */
export function deriveFefo<
  T extends {
    id: string;
    productId: string;
    variantId: string | null;
    qty: { toNumber(): number };
    expiresAt: Date | null;
    receivedAt: Date;
  },
>(
  batches: T[],
  levels: {
    productId: string;
    variantId: string | null;
    qty: { toNumber(): number };
  }[],
) {
  const key = (p: string, v: string | null) => p + ':' + (v ?? '');
  const sorted = [...batches].sort(
    (a, b) =>
      (a.expiresAt?.getTime() ?? Infinity) -
        (b.expiresAt?.getTime() ?? Infinity) ||
      a.receivedAt.getTime() - b.receivedAt.getTime() ||
      a.id.localeCompare(b.id),
  );
  const totals = new Map<string, number>();
  for (const batch of sorted) {
    const k = key(batch.productId, batch.variantId);
    totals.set(k, (totals.get(k) ?? 0) + batch.qty.toNumber());
  }
  const consumed = new Map<string, number>();
  for (const [k, total] of totals)
    consumed.set(
      k,
      Math.max(
        0,
        total -
          (levels
            .find((l) => key(l.productId, l.variantId) === k)
            ?.qty.toNumber() ?? 0),
      ),
    );
  return sorted.map((batch) => {
    const k = key(batch.productId, batch.variantId),
      used = Math.min(batch.qty.toNumber(), consumed.get(k) ?? 0);
    consumed.set(k, (consumed.get(k) ?? 0) - used);
    return {
      ...batch,
      remainingQty: Number((batch.qty.toNumber() - used).toFixed(3)),
    };
  });
}
