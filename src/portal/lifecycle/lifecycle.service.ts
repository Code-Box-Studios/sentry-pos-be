import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
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
  NotFoundError,
  ValidationFailedError,
} from '../../common/errors/api-errors';
import { AuditService } from '../../auth/audit.service';
import { seedDemoBusiness } from '../demo-seed';
import { toCsv, centavosToPesos } from '../analytics/csv';
import { csvZip } from './zip';
import { CloseAccountDto, ResetDemoDto } from './lifecycle.dto';
export const CLOSURE_GRACE_MS = 90 * 86400000;
const SECRET_KEYS = /password|pin|token|totp|secret|session/i;
/** Audit snapshots may contain historic authentication fields. Strip secrets
 * recursively before any export (including nested changes and metadata). */
export function redactSecrets(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Prisma.Decimal) return value.toString();
  if (Array.isArray(value)) return value.map(redactSecrets);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SECRET_KEYS.test(key))
      .map(([key, item]) => [key, redactSecrets(item)]),
  );
}
function csv<T extends object>(
  name: string,
  rows: T[],
  columns: (keyof T & string)[],
  money: (keyof T & string)[] = [],
) {
  return {
    name: name + '.csv',
    content: toCsv([
      {
        columns: columns.map((k) => (money.includes(k) ? k + 'Pesos' : k)),
        rows: rows.map((row) =>
          columns.map((k) => {
            const value = (row as Record<string, unknown>)[k];
            if (value === null || value === undefined) return null;
            if (money.includes(k)) return centavosToPesos(Number(value));
            if (value instanceof Prisma.Decimal) return value.toString();
            if (typeof value === 'object')
              return value instanceof Date
                ? value.toISOString()
                : JSON.stringify(redactSecrets(value));
            const text =
              typeof value === 'string'
                ? value
                : typeof value === 'number' ||
                    typeof value === 'boolean' ||
                    typeof value === 'bigint'
                  ? value.toString()
                  : '';
            return /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
          }),
        ),
      },
    ]),
  };
}
@Injectable()
export class LifecycleService {
  constructor(
    @Inject(SCOPED_PRISMA) private readonly scoped: ScopedPrisma,
    private readonly raw: PrismaService,
    private readonly audit: AuditService,
  ) {}
  private ownerId() {
    const id = getContext().ownerId;
    if (!id) throw new NotFoundError('Owner not found.');
    return id;
  }
  async export() {
    const ownerId = this.ownerId(),
      id = randomUUID();
    return this.raw.$transaction(
      async (tx) => {
        // Owner identity comes exclusively from the authenticated guard, never a
        // request parameter; raw bulk reads below repeat its relation predicate.
        const businesses = await tx.business.findMany({ where: { ownerId } }),
          businessIds = businesses.map((b) => b.id);
        const inBusiness = { in: businessIds };
        const branches = await tx.branch.findMany({
            where: { businessId: inBusiness },
          }),
          branchIds = branches.map((b) => b.id),
          inBranch = { in: branchIds };
        const products = await tx.product.findMany({
          where: { businessId: inBusiness },
          include: { variants: true },
        });
        const sales = await tx.sale.findMany({
          where: { branchId: inBranch },
          include: { items: true },
        });
        const payments = await tx.salePayment.findMany({
          where: { sale: { branchId: inBranch } },
        });
        const shifts = await tx.shift.findMany({
          where: { branchId: inBranch },
        });
        const movements = await tx.stockMovement.findMany({
          where: { branchId: inBranch },
        });
        const stock = await tx.branchStock.findMany({
          where: { branchId: inBranch },
        });
        const counts = await tx.stockCount.findMany({
          where: { branchId: inBranch },
          include: { items: true },
        });
        const batches = await tx.stockBatch.findMany({
          where: { product: { businessId: inBusiness } },
        });
        const logs = await tx.auditLog.findMany({
          where: { ownerId, actorType: { not: 'platform_admin' } },
        });
        const owner = await tx.owner.findUniqueOrThrow({
          where: { id: ownerId },
        });
        const users = await tx.user.findMany({
          where: { ownerId },
          select: {
            id: true,
            email: true,
            role: true,
            ownerId: true,
            createdAt: true,
            deletedAt: true,
          },
        });
        const categories = await tx.category.findMany({
          where: { businessId: inBusiness },
        });
        const modifierGroups = await tx.modifierGroup.findMany({
          where: { businessId: inBusiness },
        });
        const modifiers = await tx.modifier.findMany({
          where: { group: { businessId: inBusiness } },
        });
        const productGroups = await tx.productModifierGroup.findMany({
          where: { product: { businessId: inBusiness } },
        });
        const discounts = await tx.discount.findMany({
          where: { businessId: inBusiness },
        });
        const terminals = await tx.terminal.findMany({
          where: { branchId: inBranch },
          select: {
            id: true,
            branchId: true,
            name: true,
            code: true,
            receiptSeq: true,
            lastSeenAt: true,
            createdAt: true,
            deletedAt: true,
          },
        });
        const shiftCash = await tx.shiftCashMovement.findMany({
          where: { shift: { branchId: inBranch } },
        });
        const notifications = await tx.notification.findMany({
          where: {
            OR: [
              { businessId: inBusiness },
              { recipientId: { in: [ownerId, ...users.map((u) => u.id)] } },
            ],
          },
        });
        const variants = products.flatMap((p) => p.variants);
        const saleItems = sales.flatMap((s) => s.items);
        const files = [
          {
            name: 'README.txt',
            content:
              'Sentry account export, version1. Generated ' +
              new Date().toISOString() +
              '\nCSV uses UTF-8 BOM and RFC4180 quoting. Top-level money columns ending Pesos are Philippine pesos; all monetary fields in nested JSON (items, variants, modifiers, audit changes) remain integer centavos. Null costs mean unknown. Decimal stock quantities use up to3 decimal places. Timestamps are UTC ISO8601. Archived and demo records are included and marked by deletedAt/isDemo. Authentication secrets, PINs, device credentials and session identifiers are excluded. Images remain object-storage references; this bundle contains the operational database records.\n',
          },
          csv(
            'account',
            [owner],
            [
              'id',
              'name',
              'email',
              'status',
              'maxBusinesses',
              'createdAt',
              'suspendedAt',
              'closedAt',
              'purgeAfter',
            ],
          ),
          csv('users', users, [
            'id',
            'email',
            'role',
            'ownerId',
            'createdAt',
            'deletedAt',
          ]),
          csv('categories', categories, [
            'id',
            'businessId',
            'name',
            'sortOrder',
            'deletedAt',
          ]),
          csv('modifier_groups', modifierGroups, [
            'id',
            'businessId',
            'name',
            'minSelect',
            'maxSelect',
            'deletedAt',
          ]),
          csv(
            'modifiers',
            modifiers,
            ['id', 'groupId', 'name', 'priceDelta', 'deletedAt'],
            ['priceDelta'],
          ),
          csv('product_modifier_groups', productGroups, [
            'id',
            'productId',
            'groupId',
            'deletedAt',
          ]),
          csv('discounts', discounts, [
            'id',
            'businessId',
            'name',
            'kind',
            'value',
            'appliesTo',
            'active',
            'deletedAt',
          ]),
          csv('terminals', terminals, [
            'id',
            'branchId',
            'name',
            'code',
            'receiptSeq',
            'lastSeenAt',
            'createdAt',
            'deletedAt',
          ]),
          csv(
            'shift_cash_movements',
            shiftCash,
            ['id', 'shiftId', 'type', 'amount', 'reason', 'createdAt'],
            ['amount'],
          ),
          csv('notifications', notifications, [
            'id',
            'recipientType',
            'recipientId',
            'type',
            'title',
            'body',
            'businessId',
            'branchId',
            'entityId',
            'readAt',
            'createdAt',
          ]),
          csv(
            'variants',
            variants,
            [
              'id',
              'productId',
              'name',
              'sku',
              'barcode',
              'price',
              'cost',
              'deletedAt',
            ],
            ['price', 'cost'],
          ),
          csv(
            'sale_items',
            saleItems,
            [
              'id',
              'saleId',
              'productId',
              'variantId',
              'nameSnapshot',
              'qty',
              'unitPrice',
              'costSnapshot',
              'discount',
              'discountId',
              'modifiers',
            ],
            ['unitPrice', 'costSnapshot', 'discount'],
          ),
          csv('businesses', businesses, [
            'id',
            'name',
            'type',
            'currency',
            'taxRate',
            'serviceChargeRate',
            'isDemo',
            'dayStartTime',
            'expiryWarningDays',
            'receiptHeader',
            'receiptFooter',
            'deletedAt',
          ]),
          csv('branches', branches, [
            'id',
            'businessId',
            'name',
            'code',
            'address',
            'deletedAt',
          ]),
          csv(
            'catalog',
            products,
            [
              'id',
              'businessId',
              'categoryId',
              'name',
              'sku',
              'barcode',
              'price',
              'cost',
              'soldBy',
              'trackStock',
              'trackExpiry',
              'active',
              'variants',
              'imagePath',
              'lowStockThreshold',
              'deletedAt',
            ],
            ['price', 'cost'],
          ),
          csv(
            'sales',
            sales,
            [
              'id',
              'branchId',
              'terminalId',
              'shiftId',
              'receiptNo',
              'status',
              'statusReason',
              'createdAtDevice',
              'orderType',
              'scPwd',
              'scPwdDiscount',
              'vatExemptSales',
              'discountId',
              'voidedAt',
              'refundedAt',
              'refundShiftId',
              'syncedAt',
              'deletedAt',
              'subtotal',
              'discount',
              'serviceCharge',
              'tax',
              'total',
              'items',
            ],
            [
              'subtotal',
              'discount',
              'serviceCharge',
              'tax',
              'total',
              'scPwdDiscount',
              'vatExemptSales',
            ],
          ),
          csv(
            'payments',
            payments,
            [
              'id',
              'saleId',
              'method',
              'reference',
              'amount',
              'tendered',
              'change',
            ],
            ['amount', 'tendered', 'change'],
          ),
          csv(
            'shifts',
            shifts,
            [
              'id',
              'branchId',
              'terminalId',
              'openedAt',
              'closedAt',
              'openingCash',
              'closingCash',
              'expectedCash',
            ],
            ['openingCash', 'closingCash', 'expectedCash'],
          ),
          csv(
            'stock_movements',
            movements,
            [
              'id',
              'createdAt',
              'branchId',
              'productId',
              'variantId',
              'type',
              'refId',
              'transferId',
              'qtyDelta',
              'reasonCategory',
              'unitCost',
              'note',
            ],
            ['unitCost'],
          ),
          csv('stock', stock, [
            'id',
            'branchId',
            'productId',
            'variantId',
            'qty',
          ]),
          csv('stock_counts', counts, [
            'id',
            'branchId',
            'status',
            'countedAt',
            'postedAt',
            'notes',
            'items',
          ]),
          csv(
            'stock_batches',
            batches,
            [
              'id',
              'branchId',
              'productId',
              'variantId',
              'qty',
              'expiresAt',
              'receivedAt',
              'unitCost',
              'receiveMovementId',
            ],
            ['unitCost'],
          ),
          csv('activity_log', logs, [
            'id',
            'createdAt',
            'actorType',
            'actorId',
            'businessId',
            'branchId',
            'action',
            'entityType',
            'entityId',
            'changes',
            'metadata',
          ]),
        ];
        const zip = csvZip(files);
        await tx.jobDelivery.create({
          data: {
            jobKey: `account-export:${ownerId}:${id}`,
            status: 'ready',
            payload: { ownerId, exportId: id },
          },
        });
        await this.audit.logPortal(
          'account.export',
          'owner',
          ownerId,
          null,
          { exportId: id },
          tx,
        );
        return { id, zip };
      },
      { isolationLevel: 'RepeatableRead', timeout: 60000 },
    );
  }
  async close(dto: CloseAccountDto) {
    const ownerId = this.ownerId();
    return this.raw.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM owners WHERE id=${ownerId}::uuid FOR UPDATE`;
      const receipt = await tx.jobDelivery.findUnique({
        where: { jobKey: `account-export:${ownerId}:${dto.exportId}` },
      });
      if (
        !receipt ||
        receipt.status !== 'ready' ||
        receipt.createdAt.getTime() < Date.now() - 86400000
      )
        throw new ValidationFailedError(
          'Download a fresh account export before closing.',
        );
      const owner = await tx.owner.findUniqueOrThrow({
        where: { id: ownerId },
      });
      if (owner.closedAt && owner.purgeAfter)
        return { closedAt: owner.closedAt, purgeAfter: owner.purgeAfter };
      const closedAt = new Date(),
        purgeAfter = new Date(closedAt.getTime() + CLOSURE_GRACE_MS);
      await tx.owner.update({
        where: { id: ownerId },
        data: { status: 'closed', closedAt, purgeAfter },
      });
      await tx.refreshToken.updateMany({
        where: { user: { ownerId }, revokedAt: null },
        data: { revokedAt: closedAt },
      });
      await tx.terminal.updateMany({
        where: { branch: { business: { ownerId } } },
        data: { deviceTokenHash: null },
      });
      await this.audit.logPortal(
        'account.closed',
        'owner',
        ownerId,
        null,
        {
          closedAt: closedAt.toISOString(),
          purgeAfter: purgeAfter.toISOString(),
          exportId: dto.exportId,
        },
        tx,
      );
      return { closedAt, purgeAfter };
    });
  }
  async resetDemo(businessId: string, dto: ResetDemoDto) {
    const ownerId = this.ownerId(),
      jobKey = `demo-reset:${ownerId}:${dto.id}`;
    return this.raw.$transaction(
      (tx) =>
        runWithTxClient(tx, async () => {
          await tx.$queryRaw`SELECT id FROM owners WHERE id=${ownerId}::uuid FOR UPDATE`;
          const replay = await tx.jobDelivery.findUnique({ where: { jobKey } });
          if (replay) {
            const payload = replay.payload as {
              oldBusinessId: string;
              businessId: string;
            };
            if (payload.oldBusinessId !== businessId)
              throw new ValidationFailedError(
                'Reset ID already belongs to another business.',
              );
            return { businessId: payload.businessId };
          }
          const business = await this.scoped.business.findFirst({
            where: { id: businessId },
          });
          if (!business) throw new NotFoundError('Business not found.');
          if (!business.isDemo)
            throw new ValidationFailedError(
              'Only demo businesses can be reset.',
            );
          const now = new Date();
          await tx.terminal.updateMany({
            where: { branch: { businessId } },
            data: { deviceTokenHash: null, deletedAt: now },
          });
          await this.scoped.business.update({
            where: { id: businessId },
            data: { deletedAt: now },
          });
          const newId = await seedDemoBusiness(tx, ownerId);
          await tx.jobDelivery.create({
            data: {
              jobKey,
              status: 'sent',
              businessId: newId,
              sentAt: now,
              payload: {
                ownerId,
                oldBusinessId: businessId,
                businessId: newId,
              },
            },
          });
          await this.audit.logPortal(
            'business.demo_reset',
            'business',
            businessId,
            businessId,
            { replacementBusinessId: newId },
            tx,
          );
          return { businessId: newId };
        }),
      { timeout: 30000 },
    );
  }
}
