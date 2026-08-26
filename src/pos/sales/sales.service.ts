import { Inject, Injectable } from '@nestjs/common';
import { Prisma, Sale } from '@prisma/client';
import {
  SCOPED_PRISMA,
  type ScopedPrisma,
} from '../../prisma/scoped-prisma.provider';
import { PrismaService } from '../../prisma/prisma.service';
import {
  getContext,
  runWithTxClient,
} from '../../common/context/request-context';
import {
  NotFoundError,
  StockConflictHttpError,
  ValidationFailedError,
} from '../../common/errors/api-errors';
import { computeTotals, type CartTotals } from '../../common/totals/totals';
import type { Cart } from '../../common/totals/cart';
import { qtyToMilli, milliToQty } from '../../common/totals/qty';
import { SaleDraftDto, CartLineDto } from './dto/sale-draft.dto';

// ---------------------------------------------------------------------------
// FE contract (frontend/pos/src/api/types.ts).
// ---------------------------------------------------------------------------

export interface CompletedSale {
  id: string;
  receiptNo: string;
  shiftId: string;
  orderType: string;
  lines: unknown[];
  orderDiscount: unknown;
  scPwd: unknown;
  totals: CartTotals;
  payment: unknown;
  createdAtDevice: string;
  status: Sale['status'];
  statusReason: string | null;
  createdAt: string;
  voidedAt: string | null;
  refundedAt: string | null;
  refundShiftId: string | null;
}

export interface SaleSummary {
  id: string;
  receiptNo: string;
  createdAt: string;
  lineCount: number;
  orderType: string;
  method: string;
  referenceNo: string | null;
  status: Sale['status'];
  statusReason: string | null;
  totalC: number;
  scPwd: boolean;
}

/** The stored draft snapshot (what the FE sent, server-validated). */
interface StoredDraft {
  lines: unknown[];
  payment: { method: string; referenceNo: string | null };
  scPwd: unknown;
  [k: string]: unknown;
}

interface LockedRow {
  id: string;
  product_id: string;
  variant_id: string | null;
  qty: string;
}

const keyOf = (productId: string, variantId: string | null): string =>
  `${productId}:${variantId ?? ''}`;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Trailing digit run of a receipt number ("DEMO-MKT-T1-000318" → 318). */
function seqOf(receiptNo: string): number {
  const m = /(\d+)\s*$/.exec(receiptNo);
  return m ? parseInt(m[1], 10) : 0;
}

/** Deterministic JSON with recursively-sorted object keys (matches the FE mock). */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown): unknown => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      );
    }
    return v;
  });
}

/**
 * Task 19 — the sale transaction. Accepts an FE `SaleDraft`, recomputes totals
 * server-side, checks stock atomically, and persists an idempotent, byte-identical
 * `CompletedSale`. Idempotency is keyed on the client `sale.id`: a replayed draft
 * returns the stored sale (assembled from the persisted `draft` snapshot + status
 * columns), never double-posting (§5.2).
 *
 * The whole write runs in ONE `$transaction` ridden by the Task 4 choke point
 * (`runWithTxClient`), so audits/rows all roll back together. Stock is serialized
 * with `SELECT … FOR UPDATE` on `branch_stock`; a short basket yields a 409
 * `stock_conflict` listing every failing line BEFORE anything is written.
 */
@Injectable()
export class SalesService {
  constructor(
    @Inject(SCOPED_PRISMA) private readonly scoped: ScopedPrisma,
    private readonly raw: PrismaService,
  ) {}

  async completeSale(
    dto: SaleDraftDto,
  ): Promise<{ replayed: boolean; sale: CompletedSale }> {
    const ctx = getContext();
    const branchId = ctx.branchId!;
    const terminalId = ctx.actor!.id;
    const businessId = ctx.businessId!;

    // 1. Idempotency fast path.
    const existing = await this.scoped.sale.findFirst({
      where: { id: dto.id },
    });
    if (existing) return { replayed: true, sale: this.assemble(existing) };

    // 2. Shift check: the draft's shift must be this terminal's open shift.
    const shift = await this.scoped.shift.findFirst({
      where: { terminalId, closedAt: null },
      select: { id: true },
    });
    if (!shift || shift.id !== dto.shiftId) {
      throw new ValidationFailedError("The sale's shift is not open.");
    }

    // 3. Business rates for the recompute.
    const business = await this.scoped.business.findFirst({
      where: { id: businessId },
      select: { taxRate: true, serviceChargeRate: true },
    });
    if (!business) throw new NotFoundError('Business not found.');

    // 4. Line integrity + current-cost snapshot, and named-discount ownership
    // (BEFORE any lock). Named discount refs are @Allow'd (unvalidated) and the
    // choke point does not police nested-create FKs, so validate them here.
    const costByLine = await this.validateLines(businessId, dto.lines);
    await this.validateDiscounts(dto);

    // 5. Server recompute must match the client's totals exactly.
    const cart: Cart = {
      id: dto.id,
      orderType: dto.orderType,
      lines: dto.lines,
      orderDiscount: dto.orderDiscount,
      scPwd: dto.scPwd,
    };
    const totals = computeTotals(cart, {
      taxRate: Number(business.taxRate),
      serviceChargeRate: Number(business.serviceChargeRate),
    });
    if (canonical(totals) !== canonical(dto.totals)) {
      throw new ValidationFailedError(
        'Totals do not match a server-side recompute.',
      );
    }

    // 6. Payment sanity.
    this.assertPayment(dto.payment, totals.totalC);

    // 7. The atomic write.
    try {
      const sale = await this.raw.$transaction((tx) =>
        runWithTxClient(tx, () =>
          this.persist(tx, dto, totals, costByLine, branchId, terminalId),
        ),
      );
      return { replayed: false, sale };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // Either a concurrent insert of the same sale.id (idempotency race →
        // return the stored sale) or a (terminalId, receiptNo) collision (422).
        const dup = await this.scoped.sale.findFirst({ where: { id: dto.id } });
        if (dup) return { replayed: true, sale: this.assemble(dup) };
        throw new ValidationFailedError(
          'This receipt number is already in use.',
        );
      }
      throw err;
    }
  }

  async listSales(date: string | null): Promise<SaleSummary[]> {
    const ctx = getContext();
    const where: Prisma.SaleWhereInput = { terminalId: ctx.actor?.id };
    if (date) {
      const start = new Date(`${date}T00:00:00+08:00`);
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      where.createdAt = { gte: start, lt: end };
    }
    const rows = await this.scoped.sale.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.assembleSummary(r));
  }

  async getSale(id: string): Promise<CompletedSale> {
    const row = await this.scoped.sale.findFirst({ where: { id } });
    if (!row) throw new NotFoundError('Sale not found.');
    return this.assemble(row);
  }

  // -------------------------------------------------------------------------
  // Transaction body
  // -------------------------------------------------------------------------

  private async persist(
    tx: Prisma.TransactionClient,
    dto: SaleDraftDto,
    totals: CartTotals,
    costByLine: Map<string, number | null>,
    branchId: string,
    terminalId: string,
  ): Promise<CompletedSale> {
    // Tracked lines (real product + trackStock), deduped by product+variant.
    const tracked = dto.lines.filter(
      (l) => l.productId !== null && l.trackStock,
    );
    const wantedMilli = new Map<string, number>();
    for (const l of tracked) {
      const k = keyOf(l.productId!, l.variantId);
      wantedMilli.set(k, (wantedMilli.get(k) ?? 0) + qtyToMilli(l.qty));
    }

    // Lock the branch_stock rows for the involved products and read availability.
    const { availableMilli, rowIdByKey } = await this.lockStock(tx, branchId, [
      ...new Set(tracked.map((l) => l.productId!)),
    ]);

    // Idempotency re-check UNDER the lock: a concurrent duplicate of this draft
    // that committed while we waited on the stock lock must replay (not re-post
    // and not surface a spurious 409 on the now-decremented stock). The pre-tx
    // fast path can't see an in-flight sibling; this can, because we serialize
    // behind its FOR UPDATE.
    const concurrent = await tx.sale.findFirst({ where: { id: dto.id } });
    if (concurrent) return this.assemble(concurrent);

    // Conflict pass — replicate the FE per-line cumulative check (missing row = 0).
    const conflicts = this.detectConflicts(dto.lines, availableMilli);
    if (conflicts.length > 0) throw new StockConflictHttpError(conflicts);

    // Decrement each deduped level.
    for (const [k, milli] of wantedMilli) {
      const rowId = rowIdByKey.get(k);
      if (!rowId) {
        // Unreachable after the conflict pass (available ≥ wanted > 0 ⇒ row exists).
        throw new ValidationFailedError(
          'Stock level not found for a tracked line.',
        );
      }
      await this.scoped.branchStock.update({
        where: { id: rowId },
        data: { qty: { decrement: (milli / 1000).toFixed(3) } },
      });
    }

    // Insert the sale (+ items + payment), fully audited via the choke point.
    const created = await this.scoped.sale.create({
      data: this.buildSaleData(dto, totals, costByLine, branchId, terminalId),
    });

    // One sale movement per tracked line (negative delta, ref = sale id).
    for (const l of tracked) {
      await this.scoped.stockMovement.create({
        data: {
          branchId,
          productId: l.productId!,
          variantId: l.variantId ?? null,
          type: 'sale',
          refId: created.id,
          qtyDelta: (-qtyToMilli(l.qty) / 1000).toFixed(3),
        },
      });
    }

    // Bump receipt_seq to a continuation point (raw, unaudited — like lastSeenAt).
    const term = await tx.terminal.findUnique({
      where: { id: terminalId },
      select: { receiptSeq: true },
    });
    const nextSeq = Math.max(term?.receiptSeq ?? 1, seqOf(dto.receiptNo) + 1);
    if (term && nextSeq !== term.receiptSeq) {
      await tx.terminal.update({
        where: { id: terminalId },
        data: { receiptSeq: nextSeq },
      });
    }

    return this.assemble(created);
  }

  private buildSaleData(
    dto: SaleDraftDto,
    totals: CartTotals,
    costByLine: Map<string, number | null>,
    branchId: string,
    terminalId: string,
  ): Prisma.SaleUncheckedCreateInput {
    const orderDiscountId =
      dto.orderDiscount && dto.orderDiscount.source === 'named'
        ? dto.orderDiscount.discountId
        : null;

    const items = dto.lines.map((line) => {
      const lt = totals.lines.find((x) => x.lineId === line.id);
      const appliedC = lt ? lt.grossC - lt.netC : 0;
      const lineDiscountId =
        line.discount &&
        line.discount.source === 'named' &&
        lt?.applied === 'promo'
          ? line.discount.discountId
          : null;
      return {
        productId: line.productId ?? null,
        variantId: line.variantId ?? null,
        nameSnapshot: line.name,
        qty: line.qty,
        unitPrice: line.unitPriceC,
        costSnapshot: costByLine.get(line.id) ?? null,
        discount: appliedC,
        discountId: lineDiscountId,
        modifiers: (line.modifiers ?? []) as unknown as Prisma.InputJsonValue,
      };
    });

    // Scalar FKs (unchecked create): the Task 4 choke point pins branchId and
    // validates terminalId/shiftId/discountId against the caller's scope.
    return {
      id: dto.id,
      branchId,
      terminalId,
      shiftId: dto.shiftId,
      receiptNo: dto.receiptNo,
      orderType: dto.orderType,
      status: 'completed',
      subtotal: totals.subtotalC,
      discount: totals.promoDiscountC,
      discountId: orderDiscountId,
      serviceCharge: totals.serviceChargeC,
      ...(dto.scPwd
        ? { scPwd: dto.scPwd as unknown as Prisma.InputJsonValue }
        : {}),
      scPwdDiscount: totals.scPwdDiscountC,
      vatExemptSales: totals.vatExemptSalesC,
      tax: totals.vatC,
      total: totals.totalC,
      createdAtDevice: new Date(dto.createdAtDevice),
      syncedAt: new Date(),
      draft: JSON.parse(JSON.stringify(dto)) as Prisma.InputJsonValue,
      items: { create: items },
      payments: {
        create: {
          id: dto.payment.id,
          method: dto.payment.method,
          reference: dto.payment.referenceNo ?? null,
          amount: dto.payment.amountC,
          tendered: dto.payment.tenderedC,
          change: dto.payment.changeC,
        },
      },
    };
  }

  // -------------------------------------------------------------------------
  // Stock helpers
  // -------------------------------------------------------------------------

  private async lockStock(
    tx: Prisma.TransactionClient,
    branchId: string,
    productIds: string[],
  ): Promise<{
    availableMilli: Map<string, number>;
    rowIdByKey: Map<string, string>;
  }> {
    const availableMilli = new Map<string, number>();
    const rowIdByKey = new Map<string, string>();
    if (productIds.length === 0) return { availableMilli, rowIdByKey };

    const rows = await tx.$queryRaw<LockedRow[]>(Prisma.sql`
      SELECT id, product_id, variant_id, qty::text AS qty
      FROM branch_stock
      WHERE branch_id = ${branchId}::uuid
        AND deleted_at IS NULL
        AND product_id IN (${Prisma.join(
          productIds.map((id) => Prisma.sql`${id}::uuid`),
        )})
      ORDER BY product_id, variant_id
      FOR UPDATE
    `);

    for (const r of rows) {
      const k = keyOf(r.product_id, r.variant_id);
      availableMilli.set(k, Math.round(parseFloat(r.qty) * 1000));
      rowIdByKey.set(k, r.id);
    }
    return { availableMilli, rowIdByKey };
  }

  private detectConflicts(
    lines: CartLineDto[],
    availableMilli: Map<string, number>,
  ): {
    lineId: string;
    productId: string;
    variantId: string | null;
    availableQty: number;
  }[] {
    const claimed = new Map<string, number>();
    const conflicts: {
      lineId: string;
      productId: string;
      variantId: string | null;
      availableQty: number;
    }[] = [];
    for (const line of lines) {
      if (line.productId === null || !line.trackStock) continue;
      const k = keyOf(line.productId, line.variantId);
      const available = availableMilli.get(k) ?? 0; // missing row = 0 (plan §4)
      const want = (claimed.get(k) ?? 0) + qtyToMilli(line.qty);
      claimed.set(k, want);
      if (want > available) {
        conflicts.push({
          lineId: line.id,
          productId: line.productId,
          variantId: line.variantId,
          availableQty: milliToQty(available),
        });
      }
    }
    return conflicts;
  }

  // -------------------------------------------------------------------------
  // Validation helpers
  // -------------------------------------------------------------------------

  /** Every product line must reference a live product and satisfy the variant rule. */
  private async validateLines(
    businessId: string,
    lines: CartLineDto[],
  ): Promise<Map<string, number | null>> {
    const costByLine = new Map<string, number | null>();
    const productIds = [
      ...new Set(
        lines.map((l) => l.productId).filter((id): id is string => id !== null),
      ),
    ];
    if (productIds.length === 0) return costByLine;

    const products = await this.scoped.product.findMany({
      where: { id: { in: productIds }, businessId },
      include: { variants: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    for (const line of lines) {
      if (line.productId === null) continue;
      const product = byId.get(line.productId);
      if (!product) {
        throw new ValidationFailedError(
          `Line ${line.id}: product does not exist in this business.`,
        );
      }
      const variants = product.variants;
      if (variants.length > 0) {
        const variant = line.variantId
          ? variants.find((v) => v.id === line.variantId)
          : undefined;
        if (!variant) {
          throw new ValidationFailedError(
            `Line ${line.id}: a valid variantId is required for this product.`,
          );
        }
        costByLine.set(line.id, variant.cost);
      } else {
        if (line.variantId) {
          throw new ValidationFailedError(
            `Line ${line.id}: this product has no variants.`,
          );
        }
        costByLine.set(line.id, product.cost);
      }
    }
    return costByLine;
  }

  /**
   * Every NAMED discount referenced by the draft (order-level or per-line) must
   * be a well-formed id owned by this business. `line.discount`/`orderDiscount`
   * are `@Allow`'d (kept verbatim, unvalidated) and the choke point polices only
   * the sale's TOP-LEVEL FKs — not the nested `sale_items.discountId` — so a
   * foreign or malformed named-discount id would otherwise land cross-tenant (or
   * crash to 500 on a bad UUID cast). Free-form (`source:'free'`) discounts carry
   * no id and are staff discretion (recorded in the snapshot), so they are skipped.
   */
  private async validateDiscounts(dto: SaleDraftDto): Promise<void> {
    const refs: unknown[] = [
      dto.orderDiscount,
      ...dto.lines.map((l) => l.discount),
    ];
    const namedIds = refs
      .filter(
        (d): d is { source: string; discountId: unknown } =>
          !!d &&
          typeof d === 'object' &&
          (d as { source?: unknown }).source === 'named',
      )
      .map((d) => d.discountId);

    if (namedIds.length === 0) return;

    for (const id of namedIds) {
      if (typeof id !== 'string' || !UUID_RE.test(id)) {
        throw new ValidationFailedError(
          'A named discount reference is malformed.',
        );
      }
    }

    const unique = [...new Set(namedIds as string[])];
    const found = await this.scoped.discount.findMany({
      where: { id: { in: unique } },
      select: { id: true },
    });
    const owned = new Set(found.map((d) => d.id));
    for (const id of unique) {
      if (!owned.has(id)) {
        throw new ValidationFailedError('Unknown discount reference.');
      }
    }
  }

  private assertPayment(
    payment: SaleDraftDto['payment'],
    totalC: number,
  ): void {
    if (payment.amountC !== totalC) {
      throw new ValidationFailedError(
        'Payment amount does not match the total.',
      );
    }
    if (payment.method === 'cash') {
      if (payment.tenderedC < totalC) {
        throw new ValidationFailedError(
          'Tendered cash is less than the total.',
        );
      }
      if (payment.changeC !== payment.tenderedC - totalC) {
        throw new ValidationFailedError(
          'Change does not equal tendered minus total.',
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Assembly (CompletedSale is always built from the stored draft + columns)
  // -------------------------------------------------------------------------

  private assemble(row: Sale): CompletedSale {
    const draft = row.draft as StoredDraft;
    return {
      ...(draft as object),
      status: row.status,
      statusReason: row.statusReason,
      createdAt: row.createdAt.toISOString(),
      voidedAt: row.voidedAt ? row.voidedAt.toISOString() : null,
      refundedAt: row.refundedAt ? row.refundedAt.toISOString() : null,
      refundShiftId: row.refundShiftId,
    } as CompletedSale;
  }

  private assembleSummary(row: Sale): SaleSummary {
    const draft = row.draft as StoredDraft;
    return {
      id: row.id,
      receiptNo: row.receiptNo,
      createdAt: row.createdAt.toISOString(),
      lineCount: Array.isArray(draft.lines) ? draft.lines.length : 0,
      orderType: row.orderType,
      method: draft.payment.method,
      referenceNo: draft.payment.referenceNo,
      status: row.status,
      statusReason: row.statusReason,
      totalC: row.total,
      scPwd: draft.scPwd !== null && draft.scPwd !== undefined,
    };
  }
}
