/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { ObjectStorageService } from '../src/media/object-storage.service';
import { assertTenantKey, prepareImage } from '../src/media/image';
import { resetDb, closeDb } from './helpers/db';

const raw = new PrismaClient();
const objects = new Map<string, Buffer>();
const storage = {
  configured: true,
  async upload(businessId: string, kind: string, bytes: Buffer) {
    const key = `${businessId}/${kind}/${randomUUID()}.webp`;
    objects.set(key, await prepareImage(bytes));
    return key;
  },
  url(businessId: string, key: string | null) {
    if (!key) return null;
    assertTenantKey(businessId, key);
    return `https://objects.example.com/${key}?signed=test`;
  },
  async remove(businessId: string, key: string) {
    await Promise.resolve();
    assertTenantKey(businessId, key);
    objects.delete(key);
  },
};

describe('Tenant media (e2e)', () => {
  let app: INestApplication;
  let png: Buffer;
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ObjectStorageService)
      .useValue(storage)
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useGlobalFilters(new ApiExceptionFilter(app.get(PrismaService)));
    await app.init();
    png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();
  });
  beforeEach(async () => {
    await resetDb();
    objects.clear();
  });
  afterAll(async () => {
    await app?.close();
    await raw.$disconnect();
    await closeDb();
  });
  async function context() {
    const owner = await raw.owner.create({
      data: {
        name: 'Media owner',
        email: `${randomUUID()}@example.test`,
        status: 'active',
      },
    });
    const user = await raw.user.create({
      data: {
        ownerId: owner.id,
        email: owner.email,
        passwordHash: 'fixture',
        role: 'owner',
      },
    });
    const business = await raw.business.create({
      data: { ownerId: owner.id, name: 'Shop', type: 'retail', taxRate: 0.12 },
    });
    const category = await raw.category.create({
      data: { businessId: business.id, name: 'Goods' },
    });
    const product = await raw.product.create({
      data: {
        businessId: business.id,
        categoryId: category.id,
        name: 'Item',
        price: 100,
      },
    });
    const { accessToken } = await app
      .get(AuthService)
      .mintTokenPair(user.id, 'owner', owner.id);
    return { business, product, token: accessToken };
  }
  it('uploads, replaces, reads and deletes an owned logo with audited database changes', async () => {
    const a = await context();
    const path = `/v1/portal/businesses/${a.business.id}/logo`;
    const first = await request(app.getHttpServer())
      .post(path)
      .auth(a.token, { type: 'bearer' })
      .attach('file', png, 'logo.png')
      .expect(201);
    expect(first.body.url).toContain(`${a.business.id}/logo/`);
    expect(objects.size).toBe(1);
    await request(app.getHttpServer())
      .post(path)
      .auth(a.token, { type: 'bearer' })
      .attach('file', png, 'new.png')
      .expect(201);
    expect(objects.size).toBe(1);
    const read = await request(app.getHttpServer())
      .get(path)
      .auth(a.token, { type: 'bearer' })
      .expect(200);
    expect(read.body.configured).toBe(true);
    await request(app.getHttpServer())
      .delete(path)
      .auth(a.token, { type: 'bearer' })
      .expect(200);
    expect(objects.size).toBe(0);
    expect(
      (await raw.business.findUniqueOrThrow({ where: { id: a.business.id } }))
        .logoPath,
    ).toBeNull();
    expect(
      await raw.auditLog.count({
        where: { businessId: a.business.id, action: 'business.update' },
      }),
    ).toBe(3);
  });
  it('rejects foreign reads, uploads and deletes without modifying storage', async () => {
    const a = await context();
    const b = await context();
    for (const path of [
      `/v1/portal/businesses/${a.business.id}/logo`,
      `/v1/portal/products/${a.product.id}/image`,
    ]) {
      await request(app.getHttpServer())
        .get(path)
        .auth(b.token, { type: 'bearer' })
        .expect(404);
      await request(app.getHttpServer())
        .post(path)
        .auth(b.token, { type: 'bearer' })
        .attach('file', png, 'logo.png')
        .expect(404);
      await request(app.getHttpServer())
        .delete(path)
        .auth(b.token, { type: 'bearer' })
        .expect(404);
    }
    expect(objects.size).toBe(0);
  });
  it('serializes concurrent logo replacements without orphaning the losing upload', async () => {
    const a = await context();
    const path = `/v1/portal/businesses/${a.business.id}/logo`;
    await Promise.all(
      [1, 2, 3].map(() =>
        request(app.getHttpServer())
          .post(path)
          .auth(a.token, { type: 'bearer' })
          .attach('file', png, 'logo.png')
          .expect(201),
      ),
    );
    const row = await raw.business.findUniqueOrThrow({
      where: { id: a.business.id },
    });
    expect(objects.size).toBe(1);
    expect(objects.has(row.logoPath!)).toBe(true);
  });
  it('normalizes product images and rejects unsafe or missing uploads', async () => {
    const a = await context();
    const path = `/v1/portal/products/${a.product.id}/image`;
    await request(app.getHttpServer())
      .post(path)
      .auth(a.token, { type: 'bearer' })
      .attach('file', png, 'item.png')
      .expect(201);
    const key = (
      await raw.product.findUniqueOrThrow({ where: { id: a.product.id } })
    ).imagePath!;
    expect((await sharp(objects.get(key)).metadata()).format).toBe('webp');
    await request(app.getHttpServer())
      .post(path)
      .auth(a.token, { type: 'bearer' })
      .attach('file', Buffer.from('<svg/>'), 'item.svg')
      .expect(400);
    await request(app.getHttpServer())
      .post(path)
      .auth(a.token, { type: 'bearer' })
      .expect(400);
    await request(app.getHttpServer())
      .post(path)
      .auth(a.token, { type: 'bearer' })
      .attach('file', Buffer.alloc(4 * 1024 * 1024 + 1), 'large.png')
      .expect(413);
    expect(objects.size).toBe(1);
  });
});
