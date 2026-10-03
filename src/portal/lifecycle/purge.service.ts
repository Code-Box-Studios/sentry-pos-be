import { queueMediaCleanup } from '../../media/media-cleanup';
import { ObjectStorageService } from '../../media/object-storage.service';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CLOSURE_GRACE_MS } from './lifecycle.service';
/** System-only worker; no HTTP endpoint can choose an owner or move time ahead.
 * The DB trigger separately enforces90 actual days for audit erasure. */
@Injectable()
export class PurgeService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly logger = new Logger(PurgeService.name);
  constructor(
    private readonly raw: PrismaService,
    private readonly storage: ObjectStorageService,
  ) {}
  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.JOBS_ENABLED === 'false')
      return;
    void this.runDue().catch(() =>
      this.logger.error('Account purge job failed; retrying on next interval.'),
    );
    this.timer = setInterval(() => {
      void this.runDue().catch(() =>
        this.logger.error(
          'Account purge job failed; retrying on next interval.',
        ),
      );
    }, 3600000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async runDue(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const now = new Date();
      const due = await this.raw.owner.findMany({
        where: {
          status: 'closed',
          closedAt: { lte: new Date(now.getTime() - CLOSURE_GRACE_MS) },
          purgeAfter: { lte: now },
        },
        select: { id: true },
        take: 50,
      });
      let purged = 0;
      for (const owner of due) {
        try {
          if (await this.purge(owner.id)) purged++;
        } catch {
          this.logger.error(
            `Account purge failed for ${owner.id}; continuing other due owners.`,
          );
        }
      }
      await this.cleanupMedia();
      return purged;
    } finally {
      this.running = false;
    }
  }
  private async cleanupMedia() {
    if (!this.storage.configured) return;
    const jobs = await this.raw.jobDelivery.findMany({
      where: {
        OR: [
          { jobKey: { startsWith: 'purge-media:' } },
          { jobKey: { startsWith: 'media-cleanup:' } },
        ],
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: 50,
    });
    for (const job of jobs) {
      try {
        const payload = job.payload as {
          objects: { businessId: string; key: string }[];
        };
        for (const object of payload.objects)
          await this.storage.remove(object.businessId, object.key);
        // S3 deletes are idempotent; another worker may finish this same manifest.
        await this.raw.jobDelivery.deleteMany({ where: { id: job.id } });
      } catch {
        await this.raw.jobDelivery.updateMany({
          where: { id: job.id },
          data: {
            attempts: { increment: 1 },
            lastError: 'Object cleanup failed; retry pending.',
          },
        });
      }
    }
  }
  private async purge(ownerId: string) {
    return this.raw.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM owners WHERE id=${ownerId}::uuid FOR UPDATE`;
        const owner = await tx.owner.findUnique({ where: { id: ownerId } }),
          now = Date.now();
        if (
          !owner ||
          owner.status !== 'closed' ||
          !owner.closedAt ||
          !owner.purgeAfter ||
          owner.closedAt.getTime() > now - CLOSURE_GRACE_MS ||
          owner.purgeAfter.getTime() > now
        )
          return false;
        const businesses = await tx.business.findMany({
            where: { ownerId },
            select: { id: true, logoPath: true },
          }),
          businessIds = businesses.map((b) => b.id);
        const inBusiness = { in: businessIds };
        const users = await tx.user.findMany({
          where: { ownerId },
          select: { id: true },
        });
        const recipientIds = [ownerId, ...users.map((u) => u.id)];
        const productImages = await tx.product.findMany({
          where: { businessId: inBusiness, imagePath: { not: null } },
          select: { businessId: true, imagePath: true },
        });
        const objects = [
          ...businesses.map((b) => ({ businessId: b.id, key: b.logoPath })),
          ...productImages.map((p) => ({
            businessId: p.businessId,
            key: p.imagePath,
          })),
        ].filter(
          (o): o is { businessId: string; key: string } =>
            !!o.key && o.key.startsWith(o.businessId + '/'),
        );
        await queueMediaCleanup(tx, objects, `purge-media:${ownerId}`);
        const branches = await tx.branch.findMany({
            where: { businessId: inBusiness },
            select: { id: true },
          }),
          inBranch = { in: branches.map((b) => b.id) };
        await tx.salePayment.deleteMany({
          where: { sale: { branchId: inBranch } },
        });
        await tx.saleItem.deleteMany({
          where: { sale: { branchId: inBranch } },
        });
        await tx.sale.deleteMany({ where: { branchId: inBranch } });
        await tx.shiftCashMovement.deleteMany({
          where: { shift: { branchId: inBranch } },
        });
        await tx.shift.deleteMany({ where: { branchId: inBranch } });
        await tx.stockCountItem.deleteMany({
          where: { stockCount: { branchId: inBranch } },
        });
        await tx.stockCount.deleteMany({ where: { branchId: inBranch } });
        await tx.stockBatch.deleteMany({
          where: { product: { businessId: inBusiness } },
        });
        await tx.stockMovement.deleteMany({ where: { branchId: inBranch } });
        await tx.branchStock.deleteMany({ where: { branchId: inBranch } });
        await tx.productModifierGroup.deleteMany({
          where: { product: { businessId: inBusiness } },
        });
        await tx.productVariant.deleteMany({
          where: { product: { businessId: inBusiness } },
        });
        await tx.product.deleteMany({ where: { businessId: inBusiness } });
        await tx.modifier.deleteMany({
          where: { group: { businessId: inBusiness } },
        });
        await tx.modifierGroup.deleteMany({
          where: { businessId: inBusiness },
        });
        await tx.discount.deleteMany({ where: { businessId: inBusiness } });
        await tx.category.deleteMany({ where: { businessId: inBusiness } });
        await tx.operatorSession.deleteMany({ where: { user: { ownerId } } });
        await tx.staffChallenge.deleteMany({ where: { user: { ownerId } } });
        await tx.staffBranch.deleteMany({
          where: { staffProfile: { businessId: inBusiness } },
        });
        await tx.staffProfile.deleteMany({ where: { businessId: inBusiness } });
        await tx.terminal.deleteMany({ where: { branchId: inBranch } });
        await tx.branch.deleteMany({ where: { businessId: inBusiness } });
        await tx.notification.deleteMany({
          where: {
            OR: [
              { businessId: inBusiness },
              { recipientId: { in: recipientIds } },
            ],
          },
        });
        await tx.jobDelivery.deleteMany({
          where: {
            OR: [
              { businessId: inBusiness },
              { jobKey: { startsWith: `account-export:${ownerId}:` } },
              { jobKey: { startsWith: `demo-reset:${ownerId}:` } },
            ],
          },
        });
        // Local to this transaction; immutable-audit trigger verifies scope and
        // deadline on every deleted row, and still rejects every UPDATE.
        await tx.$executeRaw`SELECT set_config('sentry.purge_owner', ${ownerId}, true)`;
        await tx.auditLog.deleteMany({
          where: {
            OR: [
              { ownerId },
              { businessId: inBusiness },
              { entityType: 'owner', entityId: ownerId },
              ...businessIds.map((id) => ({
                metadata: { path: ['browsedBusinessId'], equals: id },
              })),
            ],
          },
        });
        await tx.business.deleteMany({ where: { ownerId } });
        await tx.authToken.deleteMany({ where: { user: { ownerId } } });
        await tx.refreshToken.deleteMany({ where: { user: { ownerId } } });
        await tx.user.deleteMany({ where: { ownerId } });
        await tx.owner.delete({ where: { id: ownerId } });
        return true;
      },
      { timeout: 60000 },
    );
  }
}
