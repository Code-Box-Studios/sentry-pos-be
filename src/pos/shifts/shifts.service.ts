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
import {
  getContext,
  runWithTxClient,
} from '../../common/context/request-context';
import { PrismaService } from '../../prisma/prisma.service';
import {
  assertOperatorWrite,
  assertTerminalWrite,
} from '../operators/operator-write';
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationFailedError,
} from '../../common/errors/api-errors';
import { OpenShiftDto } from './dto/open-shift.dto';
import { CashMovementDto } from './dto/cash-movement.dto';
import { CloseShiftDto } from './dto/close-shift.dto';
import { EmergencyCloseDto } from './dto/emergency-close.dto';
import { ApprovalService } from '../operators/approval.service';

// ---------------------------------------------------------------------------
// FE contract (frontend/pos/src/api/types.ts) — the shift shapes the POS uses.
// ---------------------------------------------------------------------------

export interface CashMovement {
  id: string;
  operatorUserId: string | null;
  type: 'in' | 'out';
  amountC: number;
  reason: string;
  at: string;
}

export interface ShiftView {
  id: string;
  operatorUserId: string | null;
  closedByUserId: string | null;
  emergencyCloseReason: string | null;
  openedAt: string;
  closedAt: string | null;
  openingCashC: number | null;
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
  operatorUserId: string | null;
  closedByUserId: string | null;
  emergencyCloseReason: string | null;
  openedAt: string;
  closedAt: string;
  openingCashC: number;
  countedCashC: number;
  overShortC: number;
  branchCode: string;
  terminalCode: string;
}

export type LiveShiftTotals =
  | (ShiftTotals & { blindCloseEnabled: false })
  | (Omit<
      ShiftTotals,
      | 'byMethod'
      | 'cashSalesC'
      | 'cashRefundsC'
      | 'cashInC'
      | 'cashOutC'
      | 'expectedCashC'
    > & {
      blindCloseEnabled: true;
      byMethod: Omit<Record<PaymentMethod, number>, 'cash'> & { cash: null };
      cashSalesC: null;
      cashRefundsC: null;
      cashInC: null;
      cashOutC: null;
      expectedCashC: null;
    });

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
    operatorUserId: m.operatorUserId,
    type: toApiType(m.type),
    amountC: m.amount,
    reason: m.reason,
    at: m.createdAt.toISOString(),
  };
}

function serializeShift(s: ShiftWithMovements): ShiftView {
  return {
    id: s.id,
    operatorUserId: s.operatorUserId,
    closedByUserId: s.closedByUserId,
    emergencyCloseReason: s.emergencyCloseReason,
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
  constructor(
    @Inject(SCOPED_PRISMA) private readonly scoped: ScopedPrisma,
    private readonly raw: PrismaService,
    private readonly approvals: ApprovalService,
  ) {}

  async current(): Promise<ShiftView | null> {
    const shift = await this.findOpenShift();
    if (!shift) return null;
    const operator = getContext().operator;
    if (operator && shift.operatorUserId !== operator.userId)
      throw new ForbiddenError('Only the shift operator can view this drawer.');
    const business = await this.scoped.business.findFirst({
      where: { id: getContext().businessId! },
      select: { blindCloseEnabled: true },
    });
    const view = serializeShift(shift);
    return !operator || business?.blindCloseEnabled
      ? { ...view, openingCashC: null, cashMovements: [] }
      : view;
  }

  async open(dto: OpenShiftDto): Promise<ShiftView> {
    const ctx = getContext();
    if (!ctx.operator)
      throw new UnauthorizedError('Unlock this terminal to continue.');
    // TerminalGuard always stamps branchId + a terminal actor.
    const terminalId = ctx.actor!.id;
    const branchId = ctx.branchId!;
    return this.write(async (tx) => {
      await assertOperatorWrite(tx);
      const existing = await this.scoped.shift.findFirst({
        where: { terminalId, closedAt: null },
        select: { id: true },
      });
      if (existing)
        throw new ValidationFailedError(
          'A shift is already open on this terminal.',
        );
      const created = await this.scoped.shift.create({
        data: {
          branchId,
          terminalId,
          openedAt: new Date(),
          openingCash: dto.openingCashC,
          operatorUserId: ctx.operator!.userId,
        },
        include: { cashMovements: true },
      });
      return serializeShift(created);
    });
  }

  async addCashMovement(dto: CashMovementDto): Promise<CashMovement> {
    const operator = getContext().operator;
    if (!operator)
      throw new UnauthorizedError('Unlock this terminal to continue.');
    const reason = dto.reason.trim();
    if (!reason) throw new ValidationFailedError('A reason is required.');

    return this.write(async (tx) => {
      await assertOperatorWrite(tx);
      const shift = await this.findOpenShift();
      if (!shift) throw new ValidationFailedError('No shift is open.');
      if (shift.operatorUserId !== operator.userId) {
        throw new ForbiddenError(
          'Only the shift operator can use this drawer.',
        );
      }

      // Child-only in tenant scope: write through the parent shift's audit path.
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
              operatorUserId: operator.userId,
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
    });
  }

  async totals(): Promise<LiveShiftTotals> {
    const shift = await this.findOpenShift();
    if (!shift) throw new ValidationFailedError('No shift is open.');
    if (shift.operatorUserId !== getContext().operator?.userId)
      throw new ForbiddenError('Only the shift operator can view this drawer.');
    const business = await this.scoped.business.findFirst({
      where: { id: getContext().businessId! },
      select: { blindCloseEnabled: true },
    });
    const totals = await this.computeTotals(shift);
    return business?.blindCloseEnabled
      ? {
          ...totals,
          blindCloseEnabled: true,
          byMethod: { ...totals.byMethod, cash: null },
          cashSalesC: null,
          cashRefundsC: null,
          cashInC: null,
          cashOutC: null,
          expectedCashC: null,
        }
      : { ...totals, blindCloseEnabled: false };
  }

  async close(dto: CloseShiftDto): Promise<ZReport> {
    const ctx = getContext();
    if (!ctx.operator)
      throw new UnauthorizedError('Unlock this terminal to continue.');
    return this.write(async (tx) => {
      await assertOperatorWrite(tx);
      const shift = await this.findOpenShift();
      if (!shift) throw new ValidationFailedError('No shift is open.');
      if (shift.operatorUserId !== ctx.operator!.userId) {
        throw new ForbiddenError(
          'Only the shift operator can close this drawer.',
        );
      }

      return this.finishClose(shift, dto.countedCashC, ctx.operator!.userId);
    });
  }

  async emergencyClose(dto: EmergencyCloseDto): Promise<ZReport> {
    const reason = dto.reason.trim();
    if (!reason)
      throw new ValidationFailedError('An emergency close reason is required.');
    const closerId = await this.approvals.authorizeEmergency(dto.approval);
    return this.write(async (tx) => {
      const ctx = getContext();
      await assertTerminalWrite(tx);
      const shift = await this.findOpenShift();
      if (!shift) throw new ValidationFailedError('No shift is open.');
      for (const userId of [
        ...new Set(
          [closerId, shift.operatorUserId].filter((id): id is string => !!id),
        ),
      ].sort()) {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      }
      await this.approvals.assertApproverWrite(tx, closerId);
      if (shift.operatorUserId) {
        const operator = await tx.user.findUnique({
          where: { id: shift.operatorUserId },
          include: { staffProfile: { include: { branches: true } } },
        });
        const profile = operator?.staffProfile;
        const available =
          operator &&
          !operator.deletedAt &&
          (operator.role === 'owner' ||
            (profile &&
              !profile.deletedAt &&
              profile.status === 'active' &&
              profile.businessId === ctx.businessId &&
              profile.branches.some(
                (b) => b.branchId === ctx.branchId && !b.deletedAt,
              )));
        if (available)
          throw new ForbiddenError(
            'An active shift operator must close their own drawer.',
          );
      }
      return this.finishClose(shift, dto.countedCashC, closerId, reason);
    });
  }

  private async finishClose(
    shift: ShiftWithMovements,
    countedCashC: number,
    closerId: string,
    emergencyCloseReason?: string,
  ): Promise<ZReport> {
    const totals = await this.computeTotals(shift);
    const closedAt = new Date();
    await this.scoped.shift.update({
      where: { id: shift.id },
      data: {
        closedAt,
        closingCash: countedCashC,
        expectedCash: totals.expectedCashC,
        closedByUserId: closerId,
        ...(emergencyCloseReason ? { emergencyCloseReason } : {}),
      },
    });
    const branch = await this.scoped.branch.findFirst({
      where: { id: shift.branchId },
      select: { code: true },
    });
    return {
      ...totals,
      shiftId: shift.id,
      operatorUserId: shift.operatorUserId,
      closedByUserId: closerId,
      emergencyCloseReason: emergencyCloseReason ?? null,
      openedAt: shift.openedAt.toISOString(),
      closedAt: closedAt.toISOString(),
      openingCashC: shift.openingCash,
      countedCashC,
      overShortC: countedCashC - totals.expectedCashC,
      branchCode: branch?.code ?? '',
      terminalCode: getContext().terminalCode ?? '',
    };
  }

  private async write<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const terminalId = getContext().terminalId;
    if (!terminalId) throw new UnauthorizedError();
    return this.raw.$transaction(
      (tx) =>
        runWithTxClient(tx, async () => {
          await tx.$queryRaw`SELECT id FROM terminals WHERE id = ${terminalId}::uuid FOR UPDATE`;
          return fn(tx);
        }),
      { timeout: 30000 },
    );
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
