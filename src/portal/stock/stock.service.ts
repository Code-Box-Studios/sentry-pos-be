import { deriveFefo } from './fefo';
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID, createHash } from 'crypto';
import { Prisma, StockMovement } from '@prisma/client';
import { AuditService } from '../../auth/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  SCOPED_PRISMA,
  type ScopedPrisma,
} from '../../prisma/scoped-prisma.provider';
import {
  getContext,
  runWithTxClient,
} from '../../common/context/request-context';
import {
  ForbiddenError,
  NotFoundError,
  ValidationFailedError,
} from '../../common/errors/api-errors';
import { ReceiveDto, ReceiveLineDto } from './dto/receive.dto';
import {
  TransferDto,
  CreateCountDto,
  UpdateCountDto,
} from './dto/inventory.dto';
import { AdjustStockDto } from './dto/adjust-stock.dto';
import { ApprovalService } from '../../pos/operators/approval.service';
import { assertOperatorWrite } from '../../pos/operators/operator-write';
import { assertManagerWrite } from '../../staff/manager-write';

type ProductWithVariants = Prisma.ProductGetPayload<{
  include: { variants: true };
}>;

export interface MovementResponse {
  id: string;
  operatorUserId: string | null;
  approvedByUserId: string | null;
  productId: string;
  variantId: string | null;
  type: StockMovement['type'];
  qtyDelta: number;
  unitCostC: number | null;
  refId: string;
}

export interface StockLevel {
  productId: string;
  productName: string;
  variantId: string | null;
  variantName: string | null;
  qty: number;
}

function serializeMovement(m: StockMovement): MovementResponse {
  return {
    id: m.id,
    operatorUserId: m.operatorUserId,
    approvedByUserId: m.approvedByUserId,
    productId: m.productId,
    variantId: m.variantId,
    type: m.type,
    qtyDelta: m.qtyDelta.toNumber(),
    unitCostC: m.unitCost,
    refId: m.refId,
  };
}

/**
 * Task 15 — the single stock mutator both the portal and (later) the POS use.
 *
 * Every mutation flows through the ScopedPrisma choke point (owner-scoping,
 * create-policing, auto-audit), wrapped in ONE raw `$transaction` per call so the
 * choke point rides it (`runWithTxClient`) and the whole receive/adjust is atomic.
 * `branch_stock.qty >= 0` is guarded by a DB CHECK; movements are the event log.
 *
 * Batches retain their original received quantity. Branch stock determines
 * FEFO-derived remaining quantities; sales never mutate batch records.
 */
@Injectable()
export class StockService {
  constructor(
    @Inject(SCOPED_PRISMA) private readonly scoped: ScopedPrisma,
    private readonly raw: PrismaService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalService,
  ) {}

  async receive(
    branchId: string,
    dto: ReceiveDto,
  ): Promise<{ operationId: string; movements: MovementResponse[] }> {
    if (
      getContext().actor?.type === 'staff' &&
      dto.lines.some((line) => line.unitCostC !== undefined)
    ) {
      throw new ForbiddenError('Managers cannot set unit cost.');
    }
    this.assertNoDuplicateLines(dto.lines);
    const operationId = dto.id ?? randomUUID();

    return this.withLevelCreateRetry(async () => {
      return this.raw.$transaction((tx) =>
        runWithTxClient(tx, async () => {
          const branch = await this.assertBranch(branchId);
          await this.lockBusiness(tx, branch.businessId);
          await assertManagerWrite(tx, branch.businessId, branchId);
          if (dto.id)
            await this.recordRequest(
              tx,
              branch.businessId,
              'stock-receive',
              dto.id,
              {
                branchId,
                lines: this.canonicalLines(
                  dto.lines.map((line) => ({
                    productId: line.productId,
                    variantId: line.variantId ?? null,
                    qty: new Prisma.Decimal(line.qty).toString(),
                    unitCostC: line.unitCostC ?? null,
                    expiryDate: line.expiryDate
                      ? new Date(line.expiryDate).toISOString()
                      : null,
                  })),
                ),
              },
            );
          const replay = await this.scoped.stockMovement.findMany({
            where: { branchId, refId: operationId, type: 'receive' },
            orderBy: { createdAt: 'asc' },
          });
          if (replay.length)
            return { operationId, movements: replay.map(serializeMovement) };
          const movements: MovementResponse[] = [];

          for (const line of dto.lines) {
            const product = await this.loadProduct(
              branch.businessId,
              line.productId,
            );
            this.assertVariantIntegrity(product, line.variantId);
            if (product.trackExpiry && !line.expiryDate) {
              throw new ValidationFailedError(
                'expiryDate is required when receiving a track_expiry product.',
              );
            }
            const variantId = line.variantId ?? null;

            await this.addToLevel(
              branchId,
              line.productId,
              variantId,
              line.qty,
            );

            const mv = await this.scoped.stockMovement.create({
              data: {
                branchId,
                productId: line.productId,
                variantId,
                type: 'receive',
                operatorUserId: getContext().actor!.id,
                // One operation ref stamped on every movement so a multi-line
                // receive groups together.
                refId: operationId,
                qtyDelta: line.qty,
                ...(line.unitCostC !== undefined
                  ? { unitCost: line.unitCostC }
                  : {}),
              },
            });
            movements.push(serializeMovement(mv));

            await this.applyCostAndBatch(product, line, branchId, mv.id);
          }

          return { operationId, movements };
        }),
      );
    });
  }

  async adjust(
    branchId: string,
    dto: AdjustStockDto,
    approvedBy: string | null = null,
  ): Promise<{
    productId: string;
    variantId: string | null;
    qty: number;
    movement: MovementResponse;
  }> {
    return this.withLevelCreateRetry(async () => {
      return this.raw.$transaction((tx) =>
        runWithTxClient(tx, async () => {
          const ctx = getContext();
          const isTerminal = ctx.actor?.type === 'terminal';
          if (isTerminal) {
            await tx.$queryRaw`SELECT id FROM terminals WHERE id = ${ctx.terminalId}::uuid FOR UPDATE`;
          }
          const branch = await this.assertBranch(branchId);
          await this.lockBusiness(tx, branch.businessId);
          // Portal stock locks business → manager user. Terminal writes must
          // follow that same order after their device lock to avoid a cycle.
          if (isTerminal) {
            await assertOperatorWrite(tx);
            await this.approvals.assertApproverWrite(tx, approvedBy);
          }
          await assertManagerWrite(tx, branch.businessId, branchId);
          await this.lockLevel(
            tx,
            branchId,
            dto.productId,
            dto.variantId ?? null,
          );
          const product = await this.loadProduct(
            branch.businessId,
            dto.productId,
          );
          this.assertVariantIntegrity(product, dto.variantId);
          const variantId = dto.variantId ?? null;

          const existing = await this.scoped.branchStock.findFirst({
            where: {
              branchId,
              productId: dto.productId,
              variantId,
              deletedAt: null,
            },
          });
          const currentQty = existing ? existing.qty.toNumber() : 0;
          const qtyDelta = dto.newQty - currentQty;

          if (existing) {
            await this.scoped.branchStock.update({
              where: { id: existing.id },
              data: { qty: dto.newQty },
            });
          } else {
            await this.scoped.branchStock.create({
              data: {
                branchId,
                productId: dto.productId,
                variantId,
                qty: dto.newQty,
              },
            });
          }

          // adjustment movements are self-referential (no external referent).
          const movementId = randomUUID();
          const mv = await this.scoped.stockMovement.create({
            data: {
              id: movementId,
              branchId,
              productId: dto.productId,
              variantId,
              type: 'adjustment',
              refId: movementId,
              qtyDelta,
              reasonCategory: dto.reasonCategory,
              operatorUserId: isTerminal ? ctx.operator!.userId : ctx.actor?.id,
              approvedByUserId: isTerminal ? approvedBy : null,
              ...(dto.note !== undefined ? { note: dto.note } : {}),
            },
          });

          return {
            productId: dto.productId,
            variantId,
            qty: dto.newQty,
            movement: serializeMovement(mv),
          };
        }),
      );
    });
  }

  async levels(branchId: string): Promise<StockLevel[]> {
    await this.assertBranch(branchId);
    // NOTE: no to-ONE `include` of product/variant here — the choke point's
    // soft-delete injection adds a `where` clause to every included relation,
    // which Prisma rejects on to-one includes. Names are resolved with a second
    // query that includes variants as a to-MANY relation instead.
    const rows = await this.scoped.branchStock.findMany({
      where: { branchId, product: { trackStock: true } },
      orderBy: { createdAt: 'asc' },
    });
    if (rows.length === 0) return [];

    const productIds = [...new Set(rows.map((r) => r.productId))];
    const products = await this.scoped.product.findMany({
      where: { id: { in: productIds } },
      select: {
        id: true,
        name: true,
        variants: { select: { id: true, name: true } },
      },
    });
    const productName = new Map(products.map((p) => [p.id, p.name]));
    const variantName = new Map<string, string>();
    for (const p of products) {
      for (const v of p.variants) variantName.set(v.id, v.name);
    }

    return rows.map((r) => ({
      productId: r.productId,
      productName: productName.get(r.productId) ?? '',
      variantId: r.variantId,
      variantName: r.variantId ? (variantName.get(r.variantId) ?? null) : null,
      qty: r.qty.toNumber(),
    }));
  }

  private canonicalLines<
    T extends { productId: string; variantId: string | null },
  >(lines: T[]): T[] {
    return [...lines].sort((a, b) =>
      (a.productId + ':' + (a.variantId ?? '')).localeCompare(
        b.productId + ':' + (b.variantId ?? ''),
      ),
    );
  }
  private async recordRequest(
    tx: Prisma.TransactionClient,
    businessId: string,
    kind: string,
    id: string,
    request: unknown,
  ) {
    const jobKey = `${kind}:${businessId}:${id}`;
    const digest = createHash('sha256')
      .update(JSON.stringify(request))
      .digest('hex');
    const existing = await tx.jobDelivery.findUnique({ where: { jobKey } });
    if (existing) {
      if ((existing.payload as { digest: string }).digest !== digest)
        throw new ValidationFailedError(
          'This request ID was already used with different details. Use a new ID for an edited request.',
        );
      return;
    }
    await tx.jobDelivery.create({
      data: {
        jobKey,
        businessId,
        status: 'sent',
        sentAt: new Date(),
        payload: { digest },
      },
    });
  }

  /** Scope is proven before locks; advisory lock serializes first-row creation,
   * while row locks also serialize against terminal sale/refund updates. */
  private async lockBusiness(tx: Prisma.TransactionClient, businessId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${businessId}, 0))`;
  }
  private async lockLevel(
    tx: Prisma.TransactionClient,
    branchId: string,
    productId: string,
    variantId: string | null,
  ) {
    await tx.$queryRaw`SELECT id FROM branch_stock WHERE branch_id=${branchId}::uuid AND product_id=${productId}::uuid AND variant_id IS NOT DISTINCT FROM ${variantId}::uuid AND deleted_at IS NULL FOR UPDATE`;
  }
  private async transaction<T>(
    branchId: string,
    fn: (tx: Prisma.TransactionClient, businessId: string) => Promise<T>,
  ): Promise<T> {
    return this.withLevelCreateRetry(() =>
      this.raw.$transaction(
        (tx) =>
          runWithTxClient(tx, async () => {
            const branch = await this.assertBranch(branchId);
            await this.lockBusiness(tx, branch.businessId);
            await assertManagerWrite(tx, branch.businessId, branchId);
            return fn(tx, branch.businessId);
          }),
        { timeout: 30000 },
      ),
    );
  }

  async transfer(branchId: string, dto: TransferDto) {
    this.assertNoDuplicateLines(dto.lines);
    return this.transaction(branchId, async (tx, businessId) => {
      await this.recordRequest(tx, businessId, 'stock-transfer', dto.id, {
        branchId,
        toBranchId: dto.toBranchId,
        note: dto.note ?? null,
        lines: this.canonicalLines(
          dto.lines.map((line) => ({
            productId: line.productId,
            variantId: line.variantId ?? null,
            qty: new Prisma.Decimal(line.qty).toString(),
          })),
        ),
      });
      const destination = await this.assertBranch(dto.toBranchId);
      if (destination.businessId !== businessId || branchId === dto.toBranchId)
        throw new ValidationFailedError(
          'Transfer requires different branches of the same business.',
        );
      const replay = await this.scoped.stockMovement.findMany({
        where: { branchId, type: 'transfer_out', transferId: dto.id },
      });
      if (replay.length)
        return (await this.transfers(branchId)).find((t) => t.id === dto.id)!;
      // Canonical row order avoids lock inversions with other inventory workflows.
      for (const line of [...dto.lines].sort((a, b) =>
        (a.productId + (a.variantId ?? '')).localeCompare(
          b.productId + (b.variantId ?? ''),
        ),
      )) {
        const product = await this.loadProduct(businessId, line.productId);
        this.assertVariantIntegrity(product, line.variantId);
        const variantId = line.variantId ?? null;
        for (const branch of [branchId, dto.toBranchId].sort())
          await this.lockLevel(tx, branch, line.productId, variantId);
        const source = await this.scoped.branchStock.findFirst({
          where: { branchId, productId: line.productId, variantId },
        });
        if (!source || source.qty.lessThan(line.qty))
          throw new ValidationFailedError('Insufficient source stock.');
        const cost = variantId
          ? product.variants.find((v) => v.id === variantId)!.cost
          : product.cost;
        // Derived batch quantities travel with expiry-tracked stock, without
        // changing the original receive records or allocating sale lines.
        const batches = product.trackExpiry
          ? (await this.remainingBatches(branchId)).filter(
              (b) =>
                b.productId === line.productId && b.variantId === variantId,
            )
          : [];
        await this.scoped.branchStock.update({
          where: { id: source.id },
          data: { qty: { decrement: line.qty } },
        });
        await this.addToLevel(
          dto.toBranchId,
          line.productId,
          variantId,
          line.qty,
        );
        for (const [branch, type, qty] of [
          [branchId, 'transfer_out', -line.qty],
          [dto.toBranchId, 'transfer_in', line.qty],
        ] as const) {
          const movement = await this.scoped.stockMovement.create({
            data: {
              branchId: branch,
              productId: line.productId,
              variantId,
              type,
              qtyDelta: qty,
              refId: dto.id,
              transferId: dto.id,
              operatorUserId: getContext().actor!.id,
              unitCost: cost,
              note: dto.note,
            },
          });
          if (type === 'transfer_in') {
            let left = line.qty;
            for (const batch of batches) {
              const amount = Math.min(left, batch.remainingQty);
              if (amount <= 0) continue;
              await this.scoped.stockBatch.create({
                data: {
                  branchId: branch,
                  productId: line.productId,
                  variantId,
                  qty: amount,
                  receivedAt: new Date(),
                  expiresAt: batch.expiryDate,
                  unitCost: batch.unitCostC,
                  receiveMovementId: movement.id,
                },
              });
              left -= amount;
            }
          }
        }
      }
      return (await this.transfers(branchId)).find((t) => t.id === dto.id)!;
    });
  }

  async transfers(branchId: string) {
    const branch = await this.assertBranch(branchId);
    const own = await this.scoped.stockMovement.findMany({
      where: {
        branchId,
        type: { in: ['transfer_in', 'transfer_out'] },
        transferId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
    });
    const ids = [...new Set(own.map((m) => m.transferId!))];
    const rows = await this.scoped.stockMovement.findMany({
      where: {
        transferId: { in: ids },
        branch: { businessId: branch.businessId },
      },
      orderBy: { createdAt: 'asc' },
    });
    return ids.map((id) => {
      const out = rows.filter(
        (m) => m.transferId === id && m.type === 'transfer_out',
      );
      const incoming = rows.find(
        (m) => m.transferId === id && m.type === 'transfer_in',
      );
      return {
        id,
        fromBranchId: out[0]?.branchId,
        toBranchId: incoming?.branchId,
        createdAt: out[0]?.createdAt,
        note: out[0]?.note ?? null,
        lines: out.map((m) => ({
          productId: m.productId,
          variantId: m.variantId,
          qty: -m.qtyDelta.toNumber(),
        })),
      };
    });
  }

  private serializeCount(
    count: Prisma.StockCountGetPayload<{ include: { items: true } }>,
  ) {
    return {
      ...count,
      items: count.items.map((i) => ({
        ...i,
        expectedQty: i.expectedQty.toNumber(),
        countedQty: i.countedQty.toNumber(),
        variance: i.countedQty.minus(i.expectedQty).toNumber(),
      })),
    };
  }
  async counts(branchId: string) {
    await this.assertBranch(branchId);
    return (
      await this.scoped.stockCount.findMany({
        where: { branchId },
        include: { items: true },
        orderBy: { createdAt: 'desc' },
      })
    ).map((c) => this.serializeCount(c));
  }
  async count(branchId: string, id: string) {
    await this.assertBranch(branchId);
    const count = await this.scoped.stockCount.findFirst({
      where: { id, branchId },
      include: { items: true },
    });
    if (!count) throw new NotFoundError('Stock count not found.');
    return this.serializeCount(count);
  }
  private async countItems(businessId: string, dto: UpdateCountDto) {
    const keys = new Set<string>();
    for (const item of dto.items) {
      const key = item.productId + ':' + (item.variantId ?? '');
      if (keys.has(key))
        throw new ValidationFailedError('Duplicate count item.');
      keys.add(key);
      const product = await this.loadProduct(businessId, item.productId);
      this.assertVariantIntegrity(product, item.variantId);
    }
    return dto.items.map((i) => ({
      productId: i.productId,
      variantId: i.variantId ?? null,
      countedQty: i.countedQty,
      expectedQty: 0,
    }));
  }
  async createCount(branchId: string, dto: CreateCountDto) {
    return this.transaction(branchId, async (tx, businessId) => {
      await this.recordRequest(tx, businessId, 'stock-count', dto.id, {
        branchId,
        notes: dto.notes ?? null,
        items: this.canonicalLines(
          dto.items.map((item) => ({
            productId: item.productId,
            variantId: item.variantId ?? null,
            countedQty: new Prisma.Decimal(item.countedQty).toString(),
          })),
        ),
      });
      const existing = await this.scoped.stockCount.findFirst({
        where: { id: dto.id, branchId },
        include: { items: true },
      });
      if (existing) return this.serializeCount(existing);
      const items = await this.countItems(businessId, dto);
      return this.serializeCount(
        await this.scoped.stockCount.create({
          data: {
            id: dto.id,
            branchId,
            notes: dto.notes,
            items: { create: items },
          },
          include: { items: true },
        }),
      );
    });
  }
  async updateCount(branchId: string, id: string, dto: UpdateCountDto) {
    return this.transaction(branchId, async (_tx, businessId) => {
      const count = await this.count(branchId, id);
      if (count.status !== 'draft')
        throw new ValidationFailedError('Posted stock counts are immutable.');
      const items = await this.countItems(businessId, dto);
      await this.scoped.stockCount.update({
        where: { id },
        data: {
          notes: dto.notes,
          items: {
            delete: count.items.map((item) => ({ id: item.id })),
            create: items,
          },
        },
      });
      return this.count(branchId, id);
    });
  }
  async postCount(branchId: string, id: string) {
    return this.transaction(branchId, async (tx, businessId) => {
      const count = await this.count(branchId, id);
      if (count.status === 'posted') return count;
      for (const item of [...count.items].sort((a, b) =>
        (a.productId + (a.variantId ?? '')).localeCompare(
          b.productId + (b.variantId ?? ''),
        ),
      )) {
        const product = await this.loadProduct(businessId, item.productId);
        this.assertVariantIntegrity(product, item.variantId ?? undefined);
        await this.lockLevel(tx, branchId, item.productId, item.variantId);
        const existing = await this.scoped.branchStock.findFirst({
          where: {
            branchId,
            productId: item.productId,
            variantId: item.variantId,
          },
        });
        const expected = existing?.qty ?? new Prisma.Decimal(0);
        const delta = new Prisma.Decimal(item.countedQty).minus(expected);
        await this.addToLevel(
          branchId,
          item.productId,
          item.variantId,
          delta.toNumber(),
        );
        await this.scoped.stockCount.update({
          where: { id },
          data: {
            items: {
              update: {
                where: { id: item.id },
                data: { expectedQty: expected },
              },
            },
          },
        });
        await this.scoped.stockMovement.create({
          data: {
            branchId,
            productId: item.productId,
            variantId: item.variantId,
            type: 'adjustment',
            refId: id,
            qtyDelta: delta,
            reasonCategory: 'count_correction',
            operatorUserId: getContext().actor!.id,
            note: count.notes,
            unitCost: item.variantId
              ? product.variants.find((v) => v.id === item.variantId)!.cost
              : product.cost,
          },
        });
      }
      await this.scoped.stockCount.update({
        where: { id },
        data: { status: 'posted', postedAt: new Date() },
      });
      return this.count(branchId, id);
    });
  }

  private async remainingBatches(branchId: string) {
    const batches = await this.scoped.stockBatch.findMany({
      where: { branchId },
      orderBy: [{ expiresAt: 'asc' }, { receivedAt: 'asc' }, { id: 'asc' }],
    });
    const levels = await this.scoped.branchStock.findMany({
      where: { branchId },
    });
    return deriveFefo(batches, levels).map((b) => ({
      id: b.id,
      productId: b.productId,
      variantId: b.variantId,
      receivedQty: b.qty.toNumber(),
      remainingQty: b.remainingQty,
      expiryDate: b.expiresAt,
      unitCostC: b.unitCost,
    }));
  }

  async expiry(branchId: string) {
    const branch = await this.assertBranch(branchId);
    const business = await this.scoped.business.findFirstOrThrow({
      where: { id: branch.businessId },
    });
    const asOf = new Date(),
      warningDays = business.expiryWarningDays;
    const products = await this.scoped.product.findMany({
      where: { businessId: branch.businessId, trackExpiry: true },
      include: { variants: true },
    });
    const batches = (await this.remainingBatches(branchId))
      .filter(
        (b) =>
          b.remainingQty > 0 &&
          b.expiryDate &&
          b.expiryDate.getTime() <= asOf.getTime() + warningDays * 86400000,
      )
      .map((b) => {
        const product = products.find((p) => p.id === b.productId);
        return {
          ...b,
          productName: product?.name ?? '',
          variantName:
            product?.variants.find((v) => v.id === b.variantId)?.name ?? null,
          daysLeft: Math.ceil(
            (b.expiryDate!.getTime() - asOf.getTime()) / 86400000,
          ),
        };
      });
    await this.audit.logPortal(
      'audit.report_read',
      'report',
      null,
      branch.businessId,
      { report: 'expiry', branchId },
    );
    return { asOf, warningDays, batches };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Retry the WHOLE operation on a branch_stock partial-unique violation
   * (P2002): two concurrent first-time level creates race; the loser's tx is
   * rolled back and, on retry, the row now exists so the findFirst→update path
   * is taken. Postgres aborts a tx on a constraint violation, so an in-tx retry
   * is impossible — the retry must re-run the whole transaction.
   */
  private async withLevelCreateRetry<T>(op: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await op();
      } catch (err) {
        if (
          attempt < 2 &&
          err instanceof Prisma.PrismaClientKnownRequestError &&
          ['P2002', 'P2034'].includes(err.code)
        ) {
          continue;
        }
        throw err;
      }
    }
  }

  private assertNoDuplicateLines(lines: ReceiveLineDto[]): void {
    const seen = new Set<string>();
    for (const line of lines) {
      const key = `${line.productId}:${line.variantId ?? ''}`;
      if (seen.has(key)) {
        throw new ValidationFailedError(
          'Duplicate line for the same product/variant in one receive; combine them.',
        );
      }
      seen.add(key);
    }
  }

  private async assertBranch(
    branchId: string,
  ): Promise<{ id: string; businessId: string }> {
    const branch = await this.scoped.branch.findFirst({
      where: { id: branchId },
      select: { id: true, businessId: true },
    });
    if (!branch) throw new NotFoundError('Branch not found.');
    return branch;
  }

  private async loadProduct(
    businessId: string,
    productId: string,
  ): Promise<ProductWithVariants> {
    const product = await this.scoped.product.findFirst({
      where: { id: productId, businessId },
      include: { variants: { where: { deletedAt: null } } },
    });
    if (!product) {
      throw new ValidationFailedError(
        'productId does not reference a product in this branch business.',
      );
    }
    if (!product.trackStock)
      throw new ValidationFailedError('Stock tracking is required.');
    return product;
  }

  /** Variant-integrity rule (§6): variantId required iff the product has variants. */
  private assertVariantIntegrity(
    product: ProductWithVariants,
    variantId?: string,
  ): void {
    if (product.variants.length > 0) {
      if (!variantId) {
        throw new ValidationFailedError(
          'variantId is required for a product with variants.',
        );
      }
      if (!product.variants.some((v) => v.id === variantId)) {
        throw new ValidationFailedError(
          'variantId does not belong to this product.',
        );
      }
    } else if (variantId) {
      throw new ValidationFailedError(
        'variantId is not allowed for a product without variants.',
      );
    }
  }

  private async addToLevel(
    branchId: string,
    productId: string,
    variantId: string | null,
    qty: number,
  ): Promise<void> {
    const existing = await this.scoped.branchStock.findFirst({
      where: { branchId, productId, variantId, deletedAt: null },
      select: { id: true },
    });
    if (existing) {
      await this.scoped.branchStock.update({
        where: { id: existing.id },
        data: { qty: { increment: qty } },
      });
    } else {
      await this.scoped.branchStock.create({
        data: { branchId, productId, variantId, qty },
      });
    }
  }

  /**
   * Latest-cost overwrite (product or variant) + an expiry batch for track_expiry
   * products. Both ride the product via the scoped choke point; the batch is a
   * nested create (StockBatch has no branchId to scope on).
   */
  private async applyCostAndBatch(
    product: ProductWithVariants,
    line: ReceiveLineDto,
    branchId: string,
    receiveMovementId: string,
  ): Promise<void> {
    const data: Prisma.ProductUpdateInput = {};

    if (line.unitCostC !== undefined) {
      if (line.variantId) {
        data.variants = {
          update: {
            where: { id: line.variantId },
            data: { cost: line.unitCostC },
          },
        };
      } else {
        data.cost = line.unitCostC;
      }
    }

    if (product.trackExpiry) {
      data.stockBatches = {
        create: [
          {
            branch: { connect: { id: branchId } },
            receiveMovementId,
            qty: line.qty,
            receivedAt: new Date(),
            ...(line.expiryDate
              ? { expiresAt: new Date(line.expiryDate) }
              : {}),
            ...(line.unitCostC !== undefined
              ? { unitCost: line.unitCostC }
              : {}),
            ...(line.variantId
              ? { variant: { connect: { id: line.variantId } } }
              : {}),
          },
        ],
      };
    }

    if (Object.keys(data).length > 0) {
      await this.scoped.product.update({ where: { id: product.id }, data });
    }
  }
}
