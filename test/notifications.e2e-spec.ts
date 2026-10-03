/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { NotificationsModule } from '../src/notifications/notifications.module';
import { NotificationJobsService } from '../src/notifications/notification-jobs.service';
import { MailService } from '../src/mail/mail.service';
import { AuthService } from '../src/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { prisma as raw, resetDb, closeDb } from './helpers/db';

const now = new Date('2026-09-15T20:00:01Z'); // Sep 16 04:00 Manila
let app: INestApplication;
let jobs: NotificationJobsService;
const send = jest.fn<Promise<void>, unknown[]>().mockResolvedValue(undefined);
let seq = 0;

async function seed(isDemo = false) {
  const owner = await raw.owner.create({
    data: {
      name: 'Owner',
      email: `owner${++seq}@example.test`,
      status: 'active',
    },
  });
  const user = await raw.user.create({
    data: {
      ownerId: owner.id,
      email: `user${seq}@example.test`,
      role: 'owner',
    },
  });
  const business = await raw.business.create({
    data: {
      ownerId: owner.id,
      name: 'Daily shop',
      type: 'retail',
      taxRate: 0.12,
      dayStartTime: '04:00',
      isDemo,
      createdAt: new Date('2026-09-01T00:00:00Z'),
    },
  });
  const branch = await raw.branch.create({
    data: { businessId: business.id, name: 'Main', code: 'MN', address: '' },
  });
  const category = await raw.category.create({
    data: { businessId: business.id, name: 'Food' },
  });
  const product = await raw.product.create({
    data: {
      businessId: business.id,
      categoryId: category.id,
      name: 'Rice',
      price: 10000,
      lowStockThreshold: 3,
      trackExpiry: true,
    },
  });
  await raw.branchStock.create({
    data: { branchId: branch.id, productId: product.id, qty: 2 },
  });
  const terminal = await raw.terminal.create({
    data: { branchId: branch.id, name: 'Till', code: 'T1' },
  });
  const { accessToken } = await app
    .get(AuthService)
    .mintTokenPair(user.id, 'owner', owner.id);
  return {
    owner,
    user,
    business,
    branch,
    product,
    terminal,
    token: accessToken,
  };
}

beforeAll(async () => {
  process.env.JOBS_ENABLED = 'false';
  const module = await Test.createTestingModule({
    imports: [AppModule, NotificationsModule],
  })
    .overrideProvider(MailService)
    .useValue({ send, enabled: true })
    .compile();
  app = module.createNestApplication();
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      errorHttpStatusCode: 422,
    }),
  );
  app.useGlobalFilters(new ApiExceptionFilter(app.get(PrismaService)));
  await app.init();
  jobs = app.get(NotificationJobsService);
});
beforeEach(async () => {
  await resetDb();
  send.mockReset().mockResolvedValue(undefined);
});
afterAll(async () => {
  await app?.close();
  await closeDb();
});

it('low stock deduplicates concurrent sweeps and re-arms after recovery', async () => {
  const c = await seed();
  await Promise.all([jobs.scanAlerts(now), jobs.scanAlerts(now)]);
  expect(await raw.notification.count()).toBe(1);
  await raw.branchStock.updateMany({ data: { qty: 5 } });
  await jobs.scanAlerts(now);
  expect((await raw.notification.findFirst())!.resolvedAt).not.toBeNull();
  await raw.branchStock.updateMany({ data: { qty: 2 } });
  await jobs.scanAlerts(now);
  expect(
    await raw.notification.count({ where: { recipientId: c.user.id } }),
  ).toBe(2);
  expect(
    await raw.notification.count({ where: { alertKey: { not: null } } }),
  ).toBe(1);
});

it('list/read/read-all require the owner recipient and never cross tenant boundaries', async () => {
  const a = await seed();
  const b = await seed();
  await jobs.scanAlerts(now);
  const mine = await raw.notification.findFirstOrThrow({
    where: { recipientId: a.user.id },
  });
  const theirs = await raw.notification.findFirstOrThrow({
    where: { recipientId: b.user.id },
  });
  const auth = `Bearer ${a.token}`;
  const list = await request(app.getHttpServer())
    .get('/v1/portal/notifications')
    .set('Authorization', auth)
    .expect(200);
  expect(list.body.total).toBe(1);
  expect(list.body.unreadCount).toBe(1);
  await request(app.getHttpServer())
    .post(`/v1/portal/notifications/${theirs.id}/read`)
    .set('Authorization', auth)
    .expect(404);
  await request(app.getHttpServer())
    .post(`/v1/portal/notifications/${mine.id}/read`)
    .set('Authorization', auth)
    .expect(200);
  await request(app.getHttpServer())
    .post('/v1/portal/notifications/read-all')
    .set('Authorization', auth)
    .expect(200);
  expect(
    (await raw.notification.findUniqueOrThrow({ where: { id: theirs.id } }))
      .readAt,
  ).toBeNull();
  await request(app.getHttpServer())
    .get('/v1/portal/notifications')
    .expect(401);
});

it('open shifts alert only after cutoff and consumed FEFO batches do not alert', async () => {
  const c = await seed();
  await raw.shift.create({
    data: {
      branchId: c.branch.id,
      terminalId: c.terminal.id,
      openedAt: new Date('2026-09-15T10:00:00Z'),
      openingCash: 0,
    },
  });
  for (const [qty, expiresAt] of [
    [5, '2026-09-16T00:00:00Z'],
    [2, '2026-12-01T00:00:00Z'],
  ] as const) {
    await raw.stockBatch.create({
      data: {
        branchId: c.branch.id,
        productId: c.product.id,
        qty,
        expiresAt: new Date(expiresAt),
        receivedAt: new Date('2026-09-10T00:00:00Z'),
      },
    });
  }
  await jobs.scanAlerts(new Date('2026-09-15T19:59:59Z'));
  expect(
    await raw.notification.count({ where: { type: 'shift_unclosed' } }),
  ).toBe(0);
  await jobs.scanAlerts(now);
  expect(
    await raw.notification.count({ where: { type: 'shift_unclosed' } }),
  ).toBe(1);
  expect(
    await raw.notification.count({ where: { type: 'expiring_soon' } }),
  ).toBe(0);
  await raw.branchStock.updateMany({ data: { qty: 7 } });
  await jobs.scanAlerts(now);
  expect(
    await raw.notification.count({ where: { type: 'expiring_soon' } }),
  ).toBe(1);
});

it('demo businesses generate neither alerts nor summary deliveries', async () => {
  await seed(true);
  await jobs.tick(now);
  expect(await raw.notification.count()).toBe(0);
  expect(await raw.jobDelivery.count()).toBe(0);
  expect(send).not.toHaveBeenCalled();
});

it('summary freezes cutoff payload and retries one durable provider identity', async () => {
  const c = await seed();
  send.mockRejectedValueOnce(new Error('network failure'));
  await jobs.enqueueSummaries(now);
  await Promise.all([jobs.deliverSummaries(now), jobs.deliverSummaries(now)]);
  const job = await raw.jobDelivery.findFirstOrThrow();
  expect(job.status).toBe('pending');
  expect(job.attempts).toBe(1);
  expect(job.jobKey).toContain('2026-09-15T20:00:00.000Z');
  await jobs.deliverSummaries(new Date(now.getTime() + 60000));
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  expect(
    (await raw.jobDelivery.findUniqueOrThrow({ where: { id: job.id } })).status,
  ).toBe('sent');
  await jobs.tick(new Date(now.getTime() + 120000));
  expect(
    await raw.jobDelivery.count({ where: { businessId: c.business.id } }),
  ).toBe(1);
  expect(send).toHaveBeenCalledTimes(2);
});

it('disabled email keeps pending deliveries untouched and in-app alerts working without enqueueing summaries', async () => {
  await seed();
  await jobs.enqueueSummaries(now);
  const pending = await raw.jobDelivery.findFirstOrThrow();
  await seed();
  const config = new ConfigService({ MAIL_ENABLED: 'false' });
  const mail = new MailService(config);
  const disabledJobs = new NotificationJobsService(
    app.get(PrismaService),
    mail,
    config,
  );
  await disabledJobs.tick(now);
  expect(await raw.notification.count()).toBe(2);
  expect(await raw.jobDelivery.count()).toBe(1);
  expect(
    await raw.jobDelivery.findUniqueOrThrow({ where: { id: pending.id } }),
  ).toEqual(pending);
  expect(mail.sentMailbox).toEqual([]);
});

it('daily summary toggle is validated, audited, scoped and suppresses pending delivery', async () => {
  const a = await seed();
  const b = await seed();
  await jobs.enqueueSummaries(now);
  await request(app.getHttpServer())
    .patch(`/v1/portal/businesses/${a.business.id}`)
    .set('Authorization', `Bearer ${a.token}`)
    .send({ dailySummaryEnabled: false })
    .expect(200);
  expect(
    (await raw.business.findUniqueOrThrow({ where: { id: a.business.id } }))
      .dailySummaryEnabled,
  ).toBe(false);
  await request(app.getHttpServer())
    .patch(`/v1/portal/businesses/${b.business.id}`)
    .set('Authorization', `Bearer ${a.token}`)
    .send({ dailySummaryEnabled: false })
    .expect(404);
  await jobs.deliverSummaries(now);
  expect(send).toHaveBeenCalledTimes(1);
  expect(
    await raw.auditLog.count({
      where: { entityId: a.business.id, action: 'business.update' },
    }),
  ).toBeGreaterThan(0);
});

it('summary includes only the completed business day with branch profit and cash variance', async () => {
  const c = await seed();
  const shift = await raw.shift.create({
    data: {
      branchId: c.branch.id,
      terminalId: c.terminal.id,
      openedAt: new Date('2026-09-15T00:00:00Z'),
      closedAt: new Date('2026-09-15T19:00:00Z'),
      openingCash: 0,
      closingCash: 12000,
      expectedCash: 10000,
    },
  });
  let saleNumber = 0;
  async function sale(
    createdAt: string,
    status: 'completed' | 'voided' | 'refunded',
    amount: number,
    cost: number | null,
  ) {
    return raw.sale.create({
      data: {
        branchId: c.branch.id,
        terminalId: c.terminal.id,
        shiftId: shift.id,
        receiptNo: `N-${++saleNumber}`,
        status,
        orderType: 'none',
        subtotal: amount,
        total: amount,
        tax: 0,
        createdAt: new Date(createdAt),
        createdAtDevice: new Date(createdAt),
        draft: {},
        items: {
          create: {
            nameSnapshot: 'Rice',
            qty: 1,
            unitPrice: amount,
            costSnapshot: cost,
            modifiers: [],
          },
        },
      },
    });
  }
  await sale('2026-09-14T20:00:00Z', 'completed', 10000, 4000);
  await sale('2026-09-15T19:59:59Z', 'completed', 5000, null);
  await sale('2026-09-15T20:00:00Z', 'completed', 99999, 1000); // exclusive end
  await sale('2026-09-14T19:59:59Z', 'completed', 99999, 1000); // before start
  await sale('2026-09-15T10:00:00Z', 'voided', 1000, 500);
  await sale('2026-09-15T11:00:00Z', 'refunded', 1000, 500);
  await jobs.enqueueSummaries(now);
  const job = await raw.jobDelivery.findFirstOrThrow();
  const payload = job.payload as { html: string };
  expect(payload.html).toContain('Sales: PHP 150.00; transactions: 2');
  expect(payload.html).toContain('gross profit on costed items: PHP 60.00');
  expect(payload.html).toContain('Revenue without known cost: PHP 50.00');
  expect(payload.html).toContain(
    'Voids: 1; refunds: 1; closed-shift over/short: PHP 20.00',
  );
  expect(payload.html).toContain('<td>Main</td><td>PHP 150.00</td>');
});

it('suspended owners are excluded and stale uncertain delivery stops before provider replay expires', async () => {
  const c = await seed();
  await jobs.enqueueSummaries(now);
  await raw.jobDelivery.updateMany({
    data: { attempts: 1, status: 'sending', claimedAt: now },
  });
  await jobs.deliverSummaries(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  expect((await raw.jobDelivery.findFirstOrThrow()).status).toBe(
    'needs_review',
  );
  expect(send).not.toHaveBeenCalled();
  await raw.owner.update({
    where: { id: c.owner.id },
    data: { status: 'suspended' },
  });
  await jobs.scanAlerts(now);
  expect(await raw.notification.count()).toBe(0);
});
