/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { PrismaService } from '../src/prisma/prisma.service';
import { MailService } from '../src/mail/mail.service';
import { hashSecret, verifySecret } from '../src/auth/hashing';
import { closeDb, resetDb } from './helpers/db';
import { seedSale } from './helpers/sales';

const raw = new PrismaClient();

describe('owner-managed staff (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await raw.$connect();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      }),
    );
    app.useGlobalFilters(new ApiExceptionFilter(app.get(PrismaService)));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
    await closeDb();
  });

  beforeEach(async () => {
    await resetDb();
    app.get(MailService).sentMailbox.length = 0;
  });

  const server = () => app.getHttpServer();

  async function ownerFixture() {
    const owner = await raw.owner.create({
      data: {
        name: 'Owner',
        email: 'owner-staff@example.test',
        status: 'active',
      },
    });
    const ownerUser = await raw.user.create({
      data: {
        role: 'owner',
        ownerId: owner.id,
        email: owner.email,
        passwordHash: await hashSecret('owner-password'),
        pinHash: await hashSecret('123456'),
      },
    });
    const business = await raw.business.create({
      data: { ownerId: owner.id, name: 'Shop', type: 'retail', taxRate: 0.12 },
    });
    const branch = await raw.branch.create({
      data: {
        businessId: business.id,
        name: 'Main',
        code: 'MAIN',
        address: 'Street',
      },
    });
    const login = await request(server())
      .post('/v1/auth/login')
      .send({
        email: owner.email,
        password: 'owner-password',
      })
      .expect(201);
    return {
      owner,
      ownerUser,
      business,
      branch,
      token: login.body.accessToken as string,
    };
  }

  it('creates a cashier without email and reveals a usable temporary PIN only once', async () => {
    const { business, branch, token } = await ownerFixture();
    const created = await request(server())
      .post(`/v1/portal/businesses/${business.id}/staff`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Ana', role: 'cashier', branchIds: [branch.id] })
      .expect(201);

    expect(created.body.temporaryPin).toMatch(/^\d{6}$/);
    expect(created.body.staff).toMatchObject({
      name: 'Ana',
      role: 'cashier',
      status: 'pending',
      branchIds: [branch.id],
    });
    const profile = await raw.staffProfile.findUniqueOrThrow({
      where: { id: created.body.staff.id as string },
      include: { user: true },
    });
    expect(profile.user.email).toBeNull();
    const challenge = await raw.staffChallenge.findFirstOrThrow({
      where: { userId: profile.userId },
    });
    expect(challenge.pinHash).not.toBe(created.body.temporaryPin);
    expect(
      await verifySecret(
        challenge.pinHash,
        created.body.temporaryPin as string,
      ),
    ).toBe(true);

    const listed = await request(server())
      .get(`/v1/portal/businesses/${business.id}/staff`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(listed.body[0].temporaryPin).toBeUndefined();
    expect(JSON.stringify(listed.body)).not.toContain(challenge.pinHash);
  });
  it('lets only the owner change a business blind-close policy', async () => {
    const { business, token } = await ownerFixture();
    const response = await request(server())
      .patch(`/v1/portal/businesses/${business.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ blindCloseEnabled: true })
      .expect(200);
    expect(response.body.blindCloseEnabled).toBe(true);
    expect(
      (await raw.business.findUniqueOrThrow({ where: { id: business.id } }))
        .blindCloseEnabled,
    ).toBe(true);
  });

  it('emails a manager temporary PIN and requires both permanent credentials before portal access', async () => {
    const { business, branch, token } = await ownerFixture();
    const created = await request(server())
      .post(`/v1/portal/businesses/${business.id}/staff`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Mae',
        role: 'manager',
        email: 'mae@example.test',
        branchIds: [branch.id],
      })
      .expect(201);
    expect(created.body.temporaryPin).toBeUndefined();
    const mail = app.get(MailService).sentMailbox.at(-1);
    expect(mail?.to).toBe('mae@example.test');
    expect(mail?.html).toContain('/login/staff');
    const temporaryPin = mail?.html.match(/\b\d{6}\b/)?.[0];
    expect(temporaryPin).toMatch(/^\d{6}$/);

    await request(server())
      .post('/v1/auth/login')
      .send({ email: 'mae@example.test', password: temporaryPin })
      .expect(401);
    await request(server())
      .post('/v1/auth/staff/setup-manager')
      .send({
        email: 'mae@example.test',
        temporaryPin,
        password: 'manager-password',
        permanentPin: temporaryPin,
      })
      .expect(422);
    const setup = await request(server())
      .post('/v1/auth/staff/setup-manager')
      .send({
        email: 'mae@example.test',
        temporaryPin,
        password: 'manager-password',
        permanentPin: '654321',
      })
      .expect(201);
    expect(setup.body.role).toBe('manager');
    expect(setup.body.accessToken).toBeDefined();
    await request(server())
      .post('/v1/auth/staff/setup-manager')
      .send({
        email: 'mae@example.test',
        temporaryPin,
        password: 'another-password',
        permanentPin: '222222',
      })
      .expect(400);
  });

  it('rejects an assignment to another business before creating a staff identity', async () => {
    const { business, token } = await ownerFixture();
    const other = await raw.business.create({
      data: {
        ownerId: business.ownerId,
        name: 'Other',
        type: 'retail',
        taxRate: 0.12,
      },
    });
    const otherBranch = await raw.branch.create({
      data: {
        businessId: other.id,
        name: 'Other branch',
        code: 'OTH',
        address: 'Other street',
      },
    });
    await request(server())
      .post(`/v1/portal/businesses/${business.id}/staff`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Ana', role: 'cashier', branchIds: [otherBranch.id] })
      .expect(422);
    expect(await raw.staffProfile.count()).toBe(0);
  });

  it('keeps incomplete manager resets on the combined initial setup path', async () => {
    const { business, branch, token } = await ownerFixture();
    for (const intent of ['reset-pin', 'reset-password']) {
      const email = `${intent}@example.test`;
      const created = await request(server())
        .post(`/v1/portal/businesses/${business.id}/staff`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Pending',
          role: 'manager',
          email,
          branchIds: [branch.id],
        })
        .expect(201);
      const userId = created.body.staff.userId as string;
      await request(server())
        .post(`/v1/portal/businesses/${business.id}/staff/${userId}/${intent}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const challenge = await raw.staffChallenge.findFirstOrThrow({
        where: { userId, usedAt: null },
      });
      expect(challenge.kind).toBe('manager_setup');
      const mail = app.get(MailService).sentMailbox.at(-1)!;
      expect(mail.html).toContain('/login/staff');
      expect(mail.html).not.toContain('mode=password');
      const temporaryPin = mail.html.match(/\b\d{6}\b/)![0];
      await request(server())
        .post('/v1/auth/staff/setup-manager')
        .send({
          email,
          temporaryPin,
          password: 'manager-password',
          permanentPin: '654321',
        })
        .expect(201);
    }
  });

  it.each(['receive', 'adjust', 'count'])(
    'rejects a queued manager %s after owner revocation',
    async (mode) => {
      const { business, branch, token } = await ownerFixture();
      const category = await raw.category.create({
        data: { businessId: business.id, name: 'Goods' },
      });
      const product = await raw.product.create({
        data: {
          businessId: business.id,
          categoryId: category.id,
          name: 'Milk',
          price: 5000,
          trackStock: true,
        },
      });
      await raw.branchStock.create({
        data: { branchId: branch.id, productId: product.id, qty: 40 },
      });
      const created = await request(server())
        .post(`/v1/portal/businesses/${business.id}/staff`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Mae',
          role: 'manager',
          email: 'mae@example.test',
          branchIds: [branch.id],
        })
        .expect(201);
      const temporaryPin = app
        .get(MailService)
        .sentMailbox.at(-1)!
        .html.match(/\b\d{6}\b/)![0];
      const setup = await request(server())
        .post('/v1/auth/staff/setup-manager')
        .send({
          email: 'mae@example.test',
          temporaryPin,
          password: 'manager-password',
          permanentPin: '654321',
        })
        .expect(201);
      let release!: () => void;
      let ready!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const locked = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const holding = raw.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${business.id}, 0))`;
          ready();
          await blocked;
        },
        { timeout: 20000 },
      );
      await locked;
      const path =
        mode === 'receive'
          ? 'receive'
          : mode === 'adjust'
            ? 'adjustments'
            : 'counts';
      const body =
        mode === 'receive'
          ? { lines: [{ productId: product.id, qty: 1 }] }
          : mode === 'adjust'
            ? {
                productId: product.id,
                newQty: 10,
                reasonCategory: 'count_correction',
              }
            : {
                id: 'b2611489-5fd3-4b34-8ed1-9ca7f025aee2',
                items: [{ productId: product.id, countedQty: 10 }],
              };
      const pending = request(server())
        .post(`/v1/portal/branches/${branch.id}/stock/${path}`)
        .set('Authorization', `Bearer ${setup.body.accessToken as string}`)
        .send(body)
        .then((response) => response);
      try {
        let queued = false;
        for (let i = 0; i < 100; i++) {
          const rows = await raw.$queryRaw<
            { waiting: boolean }[]
          >`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted) AS waiting`;
          if (rows[0].waiting) {
            queued = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(queued).toBe(true);
        await request(server())
          .post(
            `/v1/portal/businesses/${business.id}/staff/${created.body.staff.userId as string}/deactivate`,
          )
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
      } finally {
        release();
        await holding;
      }
      expect((await pending).status).toBe(403);
      expect(
        (
          await raw.branchStock.findFirstOrThrow({
            where: { branchId: branch.id, productId: product.id },
          })
        ).qty.toNumber(),
      ).toBe(40);
      expect(await raw.stockMovement.count()).toBe(0);
      expect(await raw.stockCount.count()).toBe(0);
    },
  );

  it('rejects a queued manager remote unpair after owner revocation', async () => {
    const { business, branch, token } = await ownerFixture();
    const terminal = await raw.terminal.create({
      data: {
        branchId: branch.id,
        name: 'Register',
        code: 'T1',
        deviceTokenHash: 'still-paired',
      },
    });
    const created = await request(server())
      .post(`/v1/portal/businesses/${business.id}/staff`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Mae',
        role: 'manager',
        email: 'mae@example.test',
        branchIds: [branch.id],
      })
      .expect(201);
    const temporaryPin = app
      .get(MailService)
      .sentMailbox.at(-1)!
      .html.match(/\b\d{6}\b/)![0];
    const setup = await request(server())
      .post('/v1/auth/staff/setup-manager')
      .send({
        email: 'mae@example.test',
        temporaryPin,
        password: 'manager-password',
        permanentPin: '654321',
      })
      .expect(201);
    let release!: () => void;
    let ready!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const holding = raw.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM terminals WHERE id = ${terminal.id}::uuid FOR UPDATE`;
        ready();
        await blocked;
      },
      { timeout: 20000 },
    );
    await locked;
    const pending = request(server())
      .post(`/v1/portal/terminals/${terminal.id}/unpair`)
      .set('Authorization', `Bearer ${setup.body.accessToken as string}`)
      .then((response) => response);
    try {
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const rows = await raw.$queryRaw<
          { waiting: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%terminals%') AS waiting`;
        if (rows[0].waiting) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      await request(server())
        .post(
          `/v1/portal/businesses/${business.id}/staff/${created.body.staff.userId as string}/deactivate`,
        )
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    } finally {
      release();
      await holding;
    }
    expect((await pending).status).toBe(403);
    expect(
      (await raw.terminal.findUniqueOrThrow({ where: { id: terminal.id } }))
        .deviceTokenHash,
    ).toBe('still-paired');
  });

  it('requires a manager email and prevents another owner from managing this business staff', async () => {
    const { business, branch, token } = await ownerFixture();
    await request(server())
      .post(`/v1/portal/businesses/${business.id}/staff`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Mae', role: 'manager', branchIds: [branch.id] })
      .expect(422);
    const otherOwner = await raw.owner.create({
      data: {
        name: 'Other owner',
        email: 'other-owner@example.test',
        status: 'active',
      },
    });
    await raw.user.create({
      data: {
        role: 'owner',
        ownerId: otherOwner.id,
        email: otherOwner.email,
        passwordHash: await hashSecret('other-password'),
      },
    });
    const otherLogin = await request(server())
      .post('/v1/auth/login')
      .send({ email: otherOwner.email, password: 'other-password' })
      .expect(201);
    await request(server())
      .get(`/v1/portal/businesses/${business.id}/staff`)
      .set('Authorization', `Bearer ${otherLogin.body.accessToken as string}`)
      .expect(404);
    expect(await raw.staffProfile.count()).toBe(0);
  });

  it('does not revive an old portal access session after staff deactivation and reactivation', async () => {
    const { business, branch, token } = await ownerFixture();
    const created = await request(server())
      .post(`/v1/portal/businesses/${business.id}/staff`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Mae',
        role: 'manager',
        email: 'mae@example.test',
        branchIds: [branch.id],
      })
      .expect(201);
    const temporaryPin = app
      .get(MailService)
      .sentMailbox.at(-1)!
      .html.match(/\b\d{6}\b/)![0];
    const setup = await request(server())
      .post('/v1/auth/staff/setup-manager')
      .send({
        email: 'mae@example.test',
        temporaryPin,
        password: 'manager-password',
        permanentPin: '654321',
      })
      .expect(201);
    const userId = created.body.staff.userId as string;
    await request(server())
      .post(`/v1/portal/businesses/${business.id}/staff/${userId}/deactivate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await request(server())
      .post(`/v1/portal/businesses/${business.id}/staff/${userId}/reactivate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await request(server())
      .get('/v1/portal/manager/context')
      .set('Authorization', `Bearer ${setup.body.accessToken as string}`)
      .expect(401);
    const fresh = await request(server())
      .post('/v1/auth/login')
      .send({ email: 'mae@example.test', password: 'manager-password' })
      .expect(201);
    await request(server())
      .get('/v1/portal/manager/context')
      .set('Authorization', `Bearer ${fresh.body.accessToken as string}`)
      .expect(200);
  });

  it('requires password reset after its one-time manager challenge and never gives a cashier portal login', async () => {
    const { business, branch, token } = await ownerFixture();
    const manager = await request(server())
      .post(`/v1/portal/businesses/${business.id}/staff`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Mae',
        role: 'manager',
        email: 'mae@example.test',
        branchIds: [branch.id],
      })
      .expect(201);
    const firstPin = app
      .get(MailService)
      .sentMailbox.at(-1)
      ?.html.match(/\b\d{6}\b/)?.[0];
    await request(server())
      .post('/v1/auth/staff/setup-manager')
      .send({
        email: 'mae@example.test',
        temporaryPin: firstPin,
        password: 'manager-password',
        permanentPin: '654321',
      })
      .expect(201);
    const login = await request(server())
      .post('/v1/auth/login')
      .send({ email: 'mae@example.test', password: 'manager-password' })
      .expect(201);
    expect(login.body.role).toBe('manager');
    await request(server())
      .post(
        `/v1/portal/businesses/${business.id}/staff/${manager.body.staff.userId as string}/reset-password`,
      )
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const resetPin = app
      .get(MailService)
      .sentMailbox.at(-1)
      ?.html.match(/\b\d{6}\b/)?.[0];
    expect(app.get(MailService).sentMailbox.at(-1)?.html).toContain(
      '/login/staff?mode=password',
    );
    await request(server())
      .post('/v1/auth/login')
      .send({ email: 'mae@example.test', password: 'manager-password' })
      .expect(401);
    await request(server())
      .post('/v1/auth/staff/setup-password')
      .send({
        email: 'mae@example.test',
        temporaryPin: resetPin,
        password: 'new-password',
      })
      .expect(201);
    await request(server())
      .post('/v1/auth/login')
      .send({ email: 'mae@example.test', password: 'new-password' })
      .expect(201);
    const cashier = await request(server())
      .post(`/v1/portal/businesses/${business.id}/staff`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Ana',
        role: 'cashier',
        email: 'ana@example.test',
        branchIds: [branch.id],
      })
      .expect(201);
    expect(cashier.body.temporaryPin).toMatch(/^\d{6}$/);
    await request(server())
      .post('/v1/auth/login')
      .send({ email: 'ana@example.test', password: cashier.body.temporaryPin })
      .expect(401);
  });

  it('invalidates an old manager setup PIN on resend and locks out after five wrong attempts', async () => {
    const { business, branch, token } = await ownerFixture();
    const created = await request(server())
      .post(`/v1/portal/businesses/${business.id}/staff`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Mae',
        role: 'manager',
        email: 'mae@example.test',
        branchIds: [branch.id],
      })
      .expect(201);
    const firstPin = app
      .get(MailService)
      .sentMailbox.at(-1)
      ?.html.match(/\b\d{6}\b/)?.[0];
    expect(firstPin).toMatch(/^\d{6}$/);

    await request(server())
      .post(
        `/v1/portal/businesses/${business.id}/staff/${created.body.staff.userId as string}/resend`,
      )
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const secondPin = app
      .get(MailService)
      .sentMailbox.at(-1)
      ?.html.match(/\b\d{6}\b/)?.[0];
    expect(secondPin).toMatch(/^\d{6}$/);
    const body = {
      email: 'mae@example.test',
      password: 'manager-password',
      permanentPin: '654321',
    };
    await request(server())
      .post('/v1/auth/staff/setup-manager')
      .send({ ...body, temporaryPin: firstPin })
      .expect(400);
    for (let attempt = 0; attempt < 5; attempt++) {
      await request(server())
        .post('/v1/auth/staff/setup-manager')
        .send({
          ...body,
          temporaryPin: '999999' === secondPin ? '888888' : '999999',
        })
        .expect(400);
    }
    await request(server())
      .post('/v1/auth/staff/setup-manager')
      .send({ ...body, temporaryPin: secondPin })
      .expect(400);
    const challenge = await raw.staffChallenge.findFirstOrThrow({
      where: { userId: created.body.staff.userId as string, usedAt: null },
    });
    expect(challenge.failedAttempts).toBe(5);
    const failed = await raw.auditLog.findMany({
      where: {
        action: 'staff.temporary_pin_failed',
        entityId: created.body.staff.userId as string,
      },
    });
    expect(failed.length).toBeGreaterThanOrEqual(5);
    expect(failed[0].metadata).toMatchObject({
      attemptedBy: created.body.staff.userId,
    });
    expect(JSON.stringify(failed)).not.toContain(secondPin);
  });

  it('rejects expired setup PINs and preserves the inactive staff profile', async () => {
    const { business, branch, token } = await ownerFixture();
    const created = await request(server())
      .post(`/v1/portal/businesses/${business.id}/staff`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Mae',
        role: 'manager',
        email: 'mae@example.test',
        branchIds: [branch.id],
      })
      .expect(201);
    const userId = created.body.staff.userId as string;
    const temporaryPin = app
      .get(MailService)
      .sentMailbox.at(-1)
      ?.html.match(/\b\d{6}\b/)?.[0];
    await raw.staffChallenge.updateMany({
      where: { userId, usedAt: null },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    await request(server())
      .post('/v1/auth/staff/setup-manager')
      .send({
        email: 'mae@example.test',
        temporaryPin,
        password: 'manager-password',
        permanentPin: '654321',
      })
      .expect(400);
    const deactivated = await request(server())
      .post(`/v1/portal/businesses/${business.id}/staff/${userId}/deactivate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(deactivated.body.status).toBe('deactivated');
    expect(
      await raw.staffProfile.findUnique({ where: { userId } }),
    ).not.toBeNull();
    const reactivated = await request(server())
      .post(`/v1/portal/businesses/${business.id}/staff/${userId}/reactivate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(reactivated.body.staff.status).toBe('pending');
    expect(reactivated.body.temporaryPin).toBeUndefined();
    expect(app.get(MailService).sentMailbox.at(-1)?.html).toMatch(/\b\d{6}\b/);
  });

  it('returns a fresh cashier PIN on role change and revokes manager refresh tokens on deactivation', async () => {
    const { business, branch, token } = await ownerFixture();
    const created = await request(server())
      .post(`/v1/portal/businesses/${business.id}/staff`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Mae',
        role: 'manager',
        email: 'mae@example.test',
        branchIds: [branch.id],
      })
      .expect(201);
    const userId = created.body.staff.userId as string;
    const temporaryPin = app
      .get(MailService)
      .sentMailbox.at(-1)
      ?.html.match(/\b\d{6}\b/)?.[0];
    const setup = await request(server())
      .post('/v1/auth/staff/setup-manager')
      .send({
        email: 'mae@example.test',
        temporaryPin,
        password: 'manager-password',
        permanentPin: '654321',
      })
      .expect(201);
    expect(
      (
        await raw.auditLog.findFirstOrThrow({
          where: { action: 'staff.manager_setup' },
        })
      ).actorType,
    ).toBe('staff');
    await request(server())
      .post(`/v1/portal/businesses/${business.id}/staff/${userId}/deactivate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await request(server())
      .post('/v1/auth/refresh')
      .send({ refreshToken: setup.body.refreshToken })
      .expect(401);
    await request(server())
      .post(`/v1/portal/businesses/${business.id}/staff/${userId}/reactivate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const changed = await request(server())
      .patch(`/v1/portal/businesses/${business.id}/staff/${userId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'cashier' })
      .expect(200);
    expect(changed.body.staff.role).toBe('cashier');
    expect(changed.body.temporaryPin).toMatch(/^\d{6}$/);
    const listed = await request(server())
      .get(`/v1/portal/businesses/${business.id}/staff`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(listed.body[0].temporaryPin).toBeUndefined();
  });

  it('lets a manager use assigned branch stock but denies another branch, staff admin and profit', async () => {
    const { business, branch, ownerUser, token } = await ownerFixture();
    const category = await raw.category.create({
      data: { businessId: business.id, name: 'Goods' },
    });
    const product = await raw.product.create({
      data: {
        businessId: business.id,
        categoryId: category.id,
        name: 'Milk',
        price: 9000,
        cost: 4300,
        trackExpiry: true,
      },
    });
    const otherBranch = await raw.branch.create({
      data: {
        businessId: business.id,
        name: 'Second',
        code: 'SECOND',
        address: 'Street 2',
      },
    });
    for (const targetBranch of [branch, otherBranch]) {
      await raw.notification.create({
        data: {
          recipientType: 'user',
          recipientId: ownerUser.id,
          type: 'low_stock',
          title: 'Low stock',
          body: `Low at ${targetBranch.name}`,
          businessId: business.id,
          branchId: targetBranch.id,
        },
      });
    }
    const mainTerminal = await raw.terminal.create({
      data: { branchId: branch.id, name: 'Main till', code: 'T-1' },
    });
    const otherTerminal = await raw.terminal.create({
      data: { branchId: otherBranch.id, name: 'Other till', code: 'T-2' },
    });
    await seedSale(raw, {
      branchId: branch.id,
      terminalId: mainTerminal.id,
      createdAt: new Date('2026-09-01T08:00:00Z'),
      lines: [{ qty: 1, unitPriceC: 10000, costC: 4300 }],
    });
    await seedSale(raw, {
      branchId: otherBranch.id,
      terminalId: otherTerminal.id,
      createdAt: new Date('2026-09-01T08:00:00Z'),
      lines: [{ qty: 1, unitPriceC: 50000, costC: 20000 }],
    });
    for (const [targetBranch, action] of [
      [branch.id, 'sale.completed'],
      [otherBranch.id, 'sale.completed'],
      [null, 'staff.updated'],
    ] as const) {
      await raw.auditLog.create({
        data: {
          actorType: targetBranch ? 'terminal' : 'owner',
          ownerId: business.ownerId,
          businessId: business.id,
          branchId: targetBranch,
          action,
          entityType: 'sale',
          changes: {},
          metadata: {},
        },
      });
    }
    await request(server())
      .post(`/v1/portal/businesses/${business.id}/staff`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Mae',
        role: 'manager',
        email: 'mae@example.test',
        branchIds: [branch.id],
      })
      .expect(201);
    const temporaryPin = app
      .get(MailService)
      .sentMailbox.at(-1)
      ?.html.match(/\b\d{6}\b/)?.[0];
    const setup = await request(server())
      .post('/v1/auth/staff/setup-manager')
      .send({
        email: 'mae@example.test',
        temporaryPin,
        password: 'manager-password',
        permanentPin: '654321',
      })
      .expect(201);
    const managerToken = setup.body.accessToken as string;
    const context = await request(server())
      .get('/v1/portal/manager/context')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    expect(context.body.branches).toMatchObject([
      { id: branch.id, name: branch.name },
    ]);
    expect(context.body.business.dayStartTime).toBe('00:00');
    const destinations = await request(server())
      .get('/v1/portal/manager/transfer-branches')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    expect(
      destinations.body.map((item: { id: string }) => item.id).sort(),
    ).toEqual([branch.id, otherBranch.id].sort());
    expect(destinations.body[0].address).toBeUndefined();
    const alerts = await request(server())
      .get('/v1/portal/manager/alerts')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    expect(alerts.body).toMatchObject([{ branchId: branch.id }]);
    const terminals = await request(server())
      .get(`/v1/portal/businesses/${business.id}/terminals`)
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    expect(
      terminals.body.map((terminal: { id: string }) => terminal.id),
    ).toEqual([mainTerminal.id]);
    const products = await request(server())
      .get(`/v1/portal/businesses/${business.id}/products`)
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    expect(products.body).toHaveLength(1);
    expect(JSON.stringify(products.body).toLowerCase()).not.toContain('cost');
    const productDetail = await request(server())
      .get(`/v1/portal/products/${product.id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    expect(productDetail.body.name).toBe('Milk');
    expect(JSON.stringify(productDetail.body).toLowerCase()).not.toContain(
      'cost',
    );
    for (const endpoint of ['categories', 'discounts', 'modifier-groups']) {
      await request(server())
        .get(`/v1/portal/businesses/${business.id}/${endpoint}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
    }
    await request(server())
      .post(`/v1/portal/businesses/${business.id}/products`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({})
      .expect(403);
    await request(server())
      .post(`/v1/portal/terminals/${otherTerminal.id}/unpair`)
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(403);
    await request(server())
      .post(`/v1/portal/terminals/${mainTerminal.id}/unpair`)
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    const activity = await request(server())
      .get(`/v1/portal/businesses/${business.id}/activity-log`)
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    expect(activity.body.total).toBeGreaterThanOrEqual(1);
    expect(
      activity.body.data.every(
        (entry: { branchId: string }) => entry.branchId === branch.id,
      ),
    ).toBe(true);
    expect(
      activity.body.data.some(
        (entry: { action: string }) => entry.action === 'sale.completed',
      ),
    ).toBe(true);
    await request(server())
      .get(
        `/v1/portal/businesses/${business.id}/activity-log?branchId=${otherBranch.id}`,
      )
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(403);
    const nearExpiry = new Date(Date.now() + 3 * 86400000).toISOString();
    await request(server())
      .post(`/v1/portal/branches/${branch.id}/stock/receive`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        lines: [
          {
            productId: product.id,
            qty: 3,
            unitCostC: 4300,
            expiryDate: nearExpiry,
          },
        ],
      })
      .expect(201);
    await request(server())
      .get(`/v1/portal/branches/${branch.id}/stock`)
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    const expiry = await request(server())
      .get(`/v1/portal/branches/${branch.id}/stock/expiry`)
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    expect(expiry.body.batches).toHaveLength(1);
    expect(JSON.stringify(expiry.body).toLowerCase()).not.toContain('cost');
    await request(server())
      .post(`/v1/portal/branches/${branch.id}/stock/receive`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        lines: [
          {
            productId: product.id,
            qty: 1,
            unitCostC: 2,
            expiryDate: nearExpiry,
          },
        ],
      })
      .expect(403);
    await request(server())
      .get(`/v1/portal/branches/${otherBranch.id}/stock`)
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(403);
    const analytics = await request(server())
      .get(
        `/v1/portal/analytics/overview?from=2026-09-01&to=2026-09-01&businessId=${business.id}`,
      )
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    expect(analytics.body.netSalesC.value).toBe(10000);
    await request(server())
      .get(
        `/v1/portal/analytics/overview?from=2026-09-01&to=2026-09-01&businessId=${business.id}&branchId=${otherBranch.id}`,
      )
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(403);
    const trend = await request(server())
      .get(
        `/v1/portal/analytics/sales/trend?from=2026-09-01&to=2026-09-01&businessId=${business.id}`,
      )
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    expect(JSON.stringify(trend.body).toLowerCase()).not.toMatch(
      /cost|profit|margin/,
    );
    const csv = await request(server())
      .get(
        `/v1/portal/analytics/sales/trend?from=2026-09-01&to=2026-09-01&businessId=${business.id}&format=csv`,
      )
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    expect(csv.text.toLowerCase()).not.toMatch(/cost|profit|margin/);
    await request(server())
      .get(`/v1/portal/businesses/${business.id}/staff`)
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(403);
    await request(server())
      .get('/v1/portal/analytics/profit?from=2026-09-01&to=2026-09-01')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(403);
    await raw.owner.update({
      where: { id: business.ownerId },
      data: { status: 'suspended' },
    });
    await request(server())
      .post('/v1/auth/refresh')
      .send({ refreshToken: setup.body.refreshToken })
      .expect(403);
  });
});
