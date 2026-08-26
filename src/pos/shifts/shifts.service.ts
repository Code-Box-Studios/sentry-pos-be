import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  CashMovementType,
  PaymentMethod,
  Prisma,
  ShiftCashMovement,
} from '@prisma/client';
import {
  SCOPED_PRISMA,
  type ScopedPrisma,
} from '../../prisma/scoped-prisma.provider';
import { getContext } from '../../common/context/request-context';
import {
  NotFoundError,
  ValidationFailedError,
} from '../../common/errors/api-errors';
import { OpenShiftDto } from './dto/open-shift.dto';
import { CashMovementDto } from './dto/cash-movement.dto';
import { CloseShiftDto } from './dto/close-shift.dto';

// ---------------------------------------------------------------------------
// FE contract (frontend/pos/src/api/types.ts) — the shift shapes the POS uses.
// ---------------------------------------------------------------------------

export interface CashMovement {
  id: string;
  type: 'in' | 'out';
  amountC: number;
  reason: string;
  at: string;
}

export interface ShiftView {
  id: string;
  openedAt: string;
  closedAt: string | null;
  openingCashC: number;
  cashMovements: CashMovement[];
}

export interface ShiftTotals {
  grossC: number;
  saleCount: number;
  byMethod: Record<PaymentMethod, number>;
  voidCount: number;
  voidAmountC: number;
  refundCount: number;
  refundAmountC: number;
  scPwdDiscountC: number;
  serviceChargeC: number;
  cashSalesC: number;
  cashRefundsC: number;
  cashInC: number;
  cashOutC: number;
  expectedCashC: number;
}

export interface ZReport extends ShiftTotals {
  shiftId: string;
  openedAt: string;
  closedAt: string;
  openingCashC: number;
  countedCashC: number;
  overShortC: number;
  branchCode: string;
  terminalCode: string;
}

type ShiftWithMovements = Prisma.ShiftGetPayload<{
  include: { cashMovements: true };
}>;
type SaleWithPayments = Prisma.SaleGetPayload<{ include: { payments: true } }>;

// The DB stores the @map'd values "in"/"out"; Prisma surfaces the enum member
// names cash_in/cash_out. Translate at the API boundary in both directions.
function toDbType(t: 'in' | 'out'): CashMovementType {
  return t === 'in' ? CashMovementType.cash_in : CashMovementType.cash_out;
}
function toApiType(t: CashMovementType): 'in' | 'out' {
  return t === CashMovementType.cash_in ? 'in' : 'out';
}

function serializeCashMovement(m: ShiftCashMovement): CashMovement {
  return {
    id: m.id,
    type: toApiType(m.type),
    amountC: m.amount,
    reason: m.reason,
    at: m.createdAt.toISOString(),
  };
}

function serializeShift(s: ShiftWithMovements): ShiftView {
  return {
    id: s.id,
    openedAt: s.openedAt.toISOString(),
    closedAt: s.closedAt ? s.closedAt.toISOString() : null,
    openingCashC: s.openingCash,
    cashMovements: s.cashMovements.map(serializeCashMovement),
  };
}

const emptyByMethod = (): Record<PaymentMethod, number> => ({
  cash: 0,
  card: 0,
  gcash: 0,
  maya: 0,
  other: 0,
});

const sum = <T>(rows: T[], pick: (row: T) => number): number =>
  rows.reduce((acc, row) => acc + pick(row), 0);

/**
 * Task 18 — POS terminal shifts (all TerminalGuard). Open a shift, record cash
 * in/out movements, read the live X totals, and close with a Z-report. The X/Z
 * aggregation mirrors the FE mock (`adapter.totalsFor`) byte-for-byte:
 *  - `sold` = this shift's NON-voided sales (a refunded sale still counts as
 *    sold; the refund subtracts separately), `voided` = its voided sales.
 *  - `refunds` = sales (any shift) whose `refundShiftId` is THIS shift.
 *  - `expectedCashC = opening + cashSales − cashRefunds + cashIn − cashOut`.
 *
 * Everything flows through the ScopedPrisma choke point, so a terminal actor is
 * pinned to its branch and the "open shift" lookup is additionally constrained to
 * this terminal. Shift open/close and cash movements auto-audit via the choke
 * point (movements are written through the parent shift — ShiftCashMovement is
 * child-only).
 */
@Injectable()
export class ShiftsService {
  constructor(@Inject(SCOPED_PRISMA) private readonly scoped: ScopedPrisma) {}

  async current(): Promise<ShiftView | null> {
    const shift = await this.findOpenShift();
    return shift ? serializeShift(shift) : null;
  }

  async open(dto: OpenShiftDto): Promise<ShiftView> {
    const ctx = getContext();
    // TerminalGuard always stamps branchId + a terminal actor.
    const terminalId = ctx.actor!.id;
    const branchId = ctx.branchId!;

    // One open shift per terminal (mirrors the single-device FE state). No DB
    // partial-unique backstop, so this is a check-then-create; a terminal is one
    // physical device, so concurrent opens from it are not a real scenario.
    const existing = await this.scoped.shift.findFirst({
      where: { terminalId, closedAt: null },
      select: { id: true },
    });
    if (existing) {
      throw new ValidationFailedError(
        'A shift is already open on this terminal.',
      );
    }

    // create-policing additionally pins branchId to the terminal's branch.
    const created = await this.scoped.shift.create({
      data: {
        branchId,
        terminalId,
        openedAt: new Date(),
        openingCash: dto.openingCashC,
      },
      include: { cashMovements: true },
    });
    return serializeShift(created);
  }

  async addCashMovement(dto: CashMovementDto): Promise<CashMovement> {
    const reason = dto.reason.trim();
    if (!reason) throw new ValidationFailedError('A reason is required.');

    const shift = await this.findOpenShift();
    if (!shift) throw new ValidationFailedError('No shift is open.');

    // ShiftCashMovement is child-only in the tenant scope: write it through the
    // parent shift's nested relation (rides the shift.update audit).
    const movementId = randomUUID();
    await this.scoped.shift.update({
      where: { id: shift.id },
      data: {
        cashMovements: {
          create: {
            id: movementId,
            type: toDbType(dto.type),
            amount: dto.amountC,
            reason,
          },
        },
      },
    });

    const refreshed = await this.scoped.shift.findFirst({
      where: { id: shift.id },
      include: { cashMovements: { where: { id: movementId } } },
    });
    const movement = refreshed?.cashMovements[0];
    if (!movement) throw new NotFoundError('Cash movement not found.');
    return serializeCashMovement(movement);
  }

  async totals(): Promise<ShiftTotals> {
    const shift = await this.findOpenShift();
    if (!shift) throw new ValidationFailedError('No shift is open.');
    return this.computeTotals(shift);
  }

  async close(dto: CloseShiftDto): Promise<ZReport> {
    const ctx = getContext();
    const shift = await this.findOpenShift();
    if (!shift) throw new ValidationFailedError('No shift is open.');

    const totals = await this.computeTotals(shift);
    const closedAt = new Date();
    await this.scoped.shift.update({
      where: { id: shift.id },
      data: {
        closedAt,
        closingCash: dto.countedCashC,
        expectedCash: totals.expectedCashC,
      },
    });

    const branch = await this.scoped.branch.findFirst({
      where: { id: shift.branchId },
      select: { code: true },
    });

    return {
      ...totals,
      shiftId: shift.id,
      openedAt: shift.openedAt.toISOString(),
      closedAt: closedAt.toISOString(),
      openingCashC: shift.openingCash,
      countedCashC: dto.countedCashC,
      overShortC: dto.countedCashC - totals.expectedCashC,
      branchCode: branch?.code ?? '',
      terminalCode: ctx.terminalCode ?? '',
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** This terminal's open shift, with movements in creation order (scope pins branch). */
  private async findOpenShift(): Promise<ShiftWithMovements | null> {
    const ctx = getContext();
    return this.scoped.shift.findFirst({
      where: { terminalId: ctx.actor?.id ?? undefined, closedAt: null },
      include: { cashMovements: { orderBy: { createdAt: 'asc' } } },
    });
  }

  private async computeTotals(shift: ShiftWithMovements): Promise<ShiftTotals> {
    const ofShift: SaleWithPayments[] = await this.scoped.sale.findMany({
      where: { shiftId: shift.id },
      include: { payments: { orderBy: { createdAt: 'asc' } } },
    });
    const sold = ofShift.filter((s) => s.status !== 'voided');
    const voided = ofShift.filter((s) => s.status === 'voided');
    const refunds: SaleWithPayments[] = await this.scoped.sale.findMany({
      where: { status: 'refunded', refundShiftId: shift.id },
      include: { payments: { orderBy: { createdAt: 'asc' } } },
    });

    // One payment per sale in this domain (FE `SaleDraft.payment` is singular);
    // orderBy above makes the pick deterministic if that ever changes.
    const methodOf = (s: SaleWithPayments): PaymentMethod | undefined =>
      s.payments[0]?.method;

    const byMethod = emptyByMethod();
    for (const s of sold) {
      const method = methodOf(s);
      if (method) byMethod[method] += s.total;
    }

    const cashSalesC = sum(
      sold.filter((s) => methodOf(s) === 'cash'),
      (s) => s.total,
    );
    const cashRefundsC = sum(
      refunds.filter((s) => methodOf(s) === 'cash'),
      (s) => s.total,
    );
    const cashInC = sum(
      shift.cashMovements.filter((m) => m.type === CashMovementType.cash_in),
      (m) => m.amount,
    );
    const cashOutC = sum(
      shift.cashMovements.filter((m) => m.type === CashMovementType.cash_out),
      (m) => m.amount,
    );

    return {
      grossC: sum(sold, (s) => s.total),
      saleCount: sold.length,
      byMethod,
      voidCount: voided.length,
      voidAmountC: sum(voided, (s) => s.total),
      refundCount: refunds.length,
      refundAmountC: sum(refunds, (s) => s.total),
      scPwdDiscountC: sum(sold, (s) => s.scPwdDiscount),
      serviceChargeC: sum(sold, (s) => s.serviceCharge),
      cashSalesC,
      cashRefundsC,
      cashInC,
      cashOutC,
      expectedCashC:
        shift.openingCash + cashSalesC - cashRefundsC + cashInC - cashOutC,
    };
  }
}
