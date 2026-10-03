import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, NotificationType, Business, Branch } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailMessage, MailService } from '../mail/mail.service';
import { deriveFefo } from '../portal/stock/fefo';
import { ScopedBusiness } from '../portal/analytics/scope/analytics-scope.service';
import {
  lineAggregateSql,
  salesAggregateSql,
  LineAggregateRow,
  SalesAggregateRow,
} from '../portal/analytics/reports/sales-aggregate.sql';
import {
  addRows,
  emptyTotals,
  grossProfitC,
  netSalesC,
} from '../portal/analytics/overview/overview.math';

const DAY = 86400000;
const MINUTE = 60000;
const ACTIVE_BUSINESS: Prisma.BusinessWhereInput = {
  deletedAt: null,
  isDemo: false,
  owner: { deletedAt: null, status: 'active' },
};

/** Most recent Manila business boundary, including an exact cutoff instant. */
export function latestBoundary(now: Date, dayStartTime: string): Date {
  const [hour, minute] = dayStartTime.split(':').map(Number);
  const offset = (8 * 60 - hour * 60 - minute) * MINUTE;
  return new Date(Math.floor((now.getTime() + offset) / DAY) * DAY - offset);
}
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
const money = (centavos: number | null) =>
  centavos === null ? 'Unknown' : `PHP ${(centavos / 100).toFixed(2)}`;

interface Alert {
  key: string;
  type: NotificationType;
  title: string;
  body: string;
  businessId: string;
  branchId: string;
  entityId: string;
}
interface SummaryPayload {
  to: string;
  subject: string;
  html: string;
  recipientId: string;
  fromUtc: string;
  toUtc: string;
}

@Injectable()
export class NotificationJobsService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly logger = new Logger(NotificationJobsService.name);
  constructor(
    private readonly raw: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    if (
      this.config.get<string>('JOBS_ENABLED') === 'false' ||
      this.config.get<string>('NODE_ENV') === 'test'
    )
      return;
    const run = () => {
      void this.tick().catch((error) =>
        this.logger.error(
          error instanceof Error ? error.message : 'Notification job failed',
        ),
      );
    };
    this.timer = setInterval(run, MINUTE);
    this.timer.unref();
    run();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      await this.scanAlerts(now);
      await this.enqueueSummaries(now);
      await this.deliverSummaries(now);
    } finally {
      this.running = false;
    }
  }

  /** System job: raw access is intentional, and every candidate proves active owner + real business. */
  async scanAlerts(now = new Date()) {
    await this.raw.$transaction(
      async (tx) => {
        // Serialize sweeps across replicas, including recovery/re-arming of the unique active key.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(74210831)`;
        const businesses = await tx.business.findMany({
          where: ACTIVE_BUSINESS,
          include: {
            owner: {
              include: { users: { where: { deletedAt: null, role: 'owner' } } },
            },
            branches: { where: { deletedAt: null } },
            products: {
              where: { deletedAt: null, active: true, trackStock: true },
              include: { variants: { where: { deletedAt: null } } },
            },
          },
        });
        const liveKeys: string[] = [];
        for (const business of businesses) {
          const alerts: Alert[] = [];
          const boundary = latestBoundary(now, business.dayStartTime);
          for (const branch of business.branches) {
            const levels = await tx.branchStock.findMany({
              where: { branchId: branch.id, deletedAt: null },
            });
            for (const product of business.products) {
              if (product.lowStockThreshold === null) continue;
              for (const variant of product.variants.length
                ? product.variants
                : [null]) {
                const qty =
                  levels
                    .find(
                      (l) =>
                        l.productId === product.id &&
                        l.variantId === (variant?.id ?? null),
                    )
                    ?.qty.toNumber() ?? 0;
                if (qty > product.lowStockThreshold.toNumber()) continue;
                const name =
                  product.name + (variant ? ` — ${variant.name}` : '');
                alerts.push({
                  key: `low:${branch.id}:${product.id}:${variant?.id ?? '-'}`,
                  type: 'low_stock',
                  title: `Low stock: ${name}`,
                  body: `${branch.name}: ${qty} remaining (threshold ${product.lowStockThreshold.toNumber()}).`,
                  businessId: business.id,
                  branchId: branch.id,
                  entityId: product.id,
                });
              }
            }
            const shifts = await tx.shift.findMany({
              where: {
                branchId: branch.id,
                deletedAt: null,
                closedAt: null,
                openedAt: { lt: boundary },
              },
              include: { terminal: true },
            });
            for (const shift of shifts)
              alerts.push({
                key: `shift:${shift.id}`,
                type: 'shift_unclosed',
                title: 'Shift left open',
                body: `${branch.name} · ${shift.terminal.code}: the business day ended at ${business.dayStartTime} with this shift still open.`,
                businessId: business.id,
                branchId: branch.id,
                entityId: shift.id,
              });
            const batches = await tx.stockBatch.findMany({
              where: {
                branchId: branch.id,
                deletedAt: null,
                productId: {
                  in: business.products
                    .filter((p) => p.trackExpiry)
                    .map((p) => p.id),
                },
              },
              include: { product: true },
            });
            for (const batch of deriveFefo(batches, levels)) {
              if (
                !batch.expiresAt ||
                batch.remainingQty <= 0 ||
                batch.expiresAt.getTime() >
                  now.getTime() + business.expiryWarningDays * DAY
              )
                continue;
              alerts.push({
                key: `expiry:${batch.id}`,
                type: 'expiring_soon',
                title: `Expiry: ${batch.product.name}`,
                body: `${branch.name}: ${batch.remainingQty} remaining; expiry ${batch.expiresAt.toISOString().slice(0, 10)}.`,
                businessId: business.id,
                branchId: branch.id,
                entityId: batch.id,
              });
            }
          }
          for (const user of business.owner.users)
            for (const alert of alerts) {
              const { key, ...data } = alert;
              const alertKey = `${user.id}:${key}`;
              liveKeys.push(alertKey);
              await tx.notification.upsert({
                where: { alertKey },
                create: {
                  ...data,
                  alertKey,
                  recipientType: 'user',
                  recipientId: user.id,
                },
                update: {},
              });
            }
        }
        await tx.notification.updateMany({
          where: { alertKey: { not: null, notIn: liveKeys }, resolvedAt: null },
          data: { resolvedAt: now, alertKey: null },
        });
      },
      { timeout: 60000 },
    );
  }

  /** Uses the same centavo report builders as Analytics; all branch IDs came from this owned business. */
  private async summary(
    tx: Prisma.TransactionClient,
    business: Business,
    branches: Branch[],
    fromUtc: Date,
    toUtc: Date,
  ) {
    const totals = emptyTotals();
    const rows: string[] = [];
    for (const branch of branches) {
      const scoped: ScopedBusiness = {
        id: business.id,
        name: business.name,
        dayStartTime: business.dayStartTime,
        dayStartMinutes: 0,
        taxRate: business.taxRate.toNumber(),
        branchIds: [branch.id],
        fromUtc,
        toUtc,
        previousFromUtc: fromUtc,
        previousToUtc: toUtc,
      };
      const [sales] = await tx.$queryRaw<SalesAggregateRow[]>(
        salesAggregateSql(scoped, fromUtc, toUtc),
      );
      const [lines] = await tx.$queryRaw<LineAggregateRow[]>(
        lineAggregateSql(scoped, fromUtc, toUtc),
      );
      addRows(totals, sales, lines);
      const branchTotals = emptyTotals();
      addRows(branchTotals, sales, lines);
      rows.push(
        `<tr><td>${escapeHtml(branch.name)}</td><td>${money(netSalesC(branchTotals))}</td><td>${branchTotals.transactions}</td><td>${money(grossProfitC(branchTotals))}</td></tr>`,
      );
    }
    const closed = await tx.shift.findMany({
      where: {
        branchId: { in: branches.map((b) => b.id) },
        deletedAt: null,
        closedAt: { gte: fromUtc, lt: toUtc },
      },
      select: { closingCash: true, expectedCash: true },
    });
    const overShortC = closed.reduce(
      (sum, shift) =>
        sum + (shift.closingCash ?? 0) - (shift.expectedCash ?? 0),
      0,
    );
    const date = new Date(fromUtc.getTime() + 8 * 60 * MINUTE)
      .toISOString()
      .slice(0, 10);
    return {
      subject: `${business.name} — daily summary ${date}`,
      html: `<h1>${escapeHtml(business.name)}</h1><p>Business day ${date}, cutoff ${escapeHtml(business.dayStartTime)} Asia/Manila.</p><p>Sales: ${money(netSalesC(totals))}; transactions: ${totals.transactions}; gross profit on costed items: ${money(grossProfitC(totals))}.</p><p>Revenue without known cost: ${money(totals.uncostedRevenueC)}. Service charge: ${money(totals.serviceChargeC)}.</p><p>Voids: ${totals.voidCount}; refunds: ${totals.refundCount}; closed-shift over/short: ${money(overShortC)}.</p><table><thead><tr><th>Branch</th><th>Sales</th><th>Transactions</th><th>Gross profit (costed items)</th></tr></thead><tbody>${rows.join('')}</tbody></table>`,
    };
  }

  async enqueueSummaries(now = new Date()) {
    if (!this.mail.enabled) return;
    await this.raw.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(74210832)`;
        const businesses = await tx.business.findMany({
          where: { ...ACTIVE_BUSINESS, dailySummaryEnabled: true },
          include: {
            branches: { where: { deletedAt: null } },
            owner: {
              include: { users: { where: { deletedAt: null, role: 'owner' } } },
            },
          },
        });
        for (const business of businesses) {
          const toUtc = latestBoundary(now, business.dayStartTime);
          if (business.createdAt >= toUtc) continue;
          const fromUtc = new Date(toUtc.getTime() - DAY);
          for (const user of business.owner.users) {
            if (!user.email) continue;
            const jobKey = `daily-summary:${business.id}:${user.id}:${toUtc.toISOString()}`;
            if (await tx.jobDelivery.findUnique({ where: { jobKey } }))
              continue;
            const message = await this.summary(
              tx,
              business,
              business.branches,
              fromUtc,
              toUtc,
            );
            const payload: SummaryPayload = {
              ...message,
              to: user.email,
              recipientId: user.id,
              fromUtc: fromUtc.toISOString(),
              toUtc: toUtc.toISOString(),
            };
            await tx.jobDelivery.create({
              data: {
                jobKey,
                businessId: business.id,
                payload: { ...payload },
                createdAt: now,
              },
            });
          }
        }
      },
      { timeout: 60000 },
    );
  }

  async deliverSummaries(now = new Date()) {
    if (!this.mail.enabled) return;
    const jobs = await this.raw.jobDelivery.findMany({
      where: {
        jobKey: { startsWith: 'daily-summary:' },
        OR: [
          {
            status: 'pending',
            OR: [
              { claimedAt: null },
              { claimedAt: { lte: new Date(now.getTime() - MINUTE) } },
            ],
          },
          {
            status: 'sending',
            claimedAt: { lt: new Date(now.getTime() - 10 * MINUTE) },
          },
        ],
      },
      take: 100,
      orderBy: { createdAt: 'asc' },
    });
    for (const job of jobs) {
      const claim = await this.raw.jobDelivery.updateMany({
        where: { id: job.id, status: job.status, attempts: job.attempts },
        data: { status: 'sending', claimedAt: now, attempts: { increment: 1 } },
      });
      if (claim.count !== 1) continue;
      const payload = job.payload as unknown as SummaryPayload;
      const business = await this.raw.business.findFirst({
        where: {
          ...ACTIVE_BUSINESS,
          id: job.businessId ?? '',
          dailySummaryEnabled: true,
        },
      });
      const user = business
        ? await this.raw.user.findFirst({
            where: {
              id: payload.recipientId,
              ownerId: business.ownerId,
              deletedAt: null,
              role: 'owner',
            },
          })
        : null;
      if (!business || !user) {
        await this.raw.jobDelivery.update({
          where: { id: job.id },
          data: { status: 'cancelled' },
        });
        continue;
      }
      // A provider's replay window is bounded. An ambiguous stale attempt needs review instead
      // of risking a duplicate email once its provider idempotency key may have expired.
      if (
        job.attempts > 0 &&
        now.getTime() - job.createdAt.getTime() >= 23 * 60 * MINUTE
      ) {
        await this.raw.jobDelivery.update({
          where: { id: job.id },
          data: {
            status: 'needs_review',
            lastError: 'Delivery retry exceeded the safe idempotency window.',
          },
        });
        continue;
      }
      const message: MailMessage = {
        to: payload.to,
        subject: payload.subject,
        html: payload.html,
        idempotencyKey: job.jobKey,
      };
      try {
        await this.mail.send(message);
        await this.raw.jobDelivery.update({
          where: { id: job.id },
          data: { status: 'sent', sentAt: now, lastError: null },
        });
      } catch (error) {
        await this.raw.jobDelivery.update({
          where: { id: job.id },
          data: {
            status: 'pending',
            lastError: (error instanceof Error
              ? error.message
              : 'Mail delivery failed'
            ).slice(0, 1000),
          },
        });
      }
    }
  }
}
