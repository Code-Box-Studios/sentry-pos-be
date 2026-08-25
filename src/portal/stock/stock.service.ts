import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma, StockMovement } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  SCOPED_PRISMA,
  type ScopedPrisma,
} from '../../prisma/scoped-prisma.provider';
import { runWithTxClient } from '../../common/context/request-context';
import {
  NotFoundError,
  ValidationFailedError,
} from '../../common/errors/api-errors';
import { ReceiveDto, ReceiveLineDto } from './dto/receive.dto';
import { AdjustStockDto } from './dto/adjust-stock.dto';

type ProductWithVariants = Prisma.ProductGetPayload<{
  include: { variants: true };
}>;

export interface MovementResponse {
  id: string;
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
 * Stock model note: StockBatch has no branchId column (unlike branch_stock /
 * stock_movements), so batches are written via a NESTED create through the
 * product (bypassing the top-level branch scope map) rather than a top-level
 * scoped.stockBatch write.
 */
@Injectable()
export class StockService {
  constructor(
    @Inject(SCOPED_PRISMA) private readonly scoped: ScopedPrisma,
    private readonly raw: PrismaService,
  ) {}

  async receive(
    branchId: string,
    dto: ReceiveDto,
  ): Promise<{ operationId: string; movements: MovementResponse[] }> {
    this.assertNoDuplicateLines(dto.lines);
    const operationId = randomUUID();

    return this.withLevelCreateRetry(async () => {
      return this.raw.$transaction((tx) =>
        runWithTxClient(tx, async () => {
          const branch = await this.assertBranch(branchId);
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

            await this.applyCostAndBatch(product, line);
          }

          return { operationId, movements };
        }),
      );
    });
  }

  async adjust(
    branchId: string,
    dto: AdjustStockDto,
  ): Promise<{
    productId: string;
    variantId: string | null;
    qty: number;
    movement: MovementResponse;
  }> {
    // `newQty` is an ABSOLUTE target. Under two concurrent adjusts on the same
    // level the final qty is authoritative (last-writer-wins, always >= 0 by DTO
    // + DB CHECK), but the recorded movement deltas are best-effort (each is
    // computed from the qty read at its own start) and may not sum to the net
    // change — acceptable for an absolute set.
    return this.withLevelCreateRetry(async () => {
      return this.raw.$transaction((tx) =>
        runWithTxClient(tx, async () => {
          const branch = await this.assertBranch(branchId);
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
          err.code === 'P2002'
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
