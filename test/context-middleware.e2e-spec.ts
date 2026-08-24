import {
  Controller,
  Get,
  INestApplication,
  MiddlewareConsumer,
  Module,
  NestModule,
  Param,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ContextMiddleware } from '../src/common/context/context.middleware';
import { getContext } from '../src/common/context/request-context';

/**
 * Test-only controller exercising a NESTED / parametric route.
 * This is intentionally test-scoped (never shipped in src/) — it exists solely
 * to prove ContextMiddleware runs on multi-segment/param routes under
 * NestJS 11 + Express 5 (path-to-regexp v8), where bare '*' wildcard routing
 * changed. The handler returns getContext().requestId, which throws if the
 * middleware did not run (i.e. no context store for this route).
 */
@Controller('ctxcheck')
class CtxCheckController {
  @Get(':id/detail')
  detail(@Param('id') id: string): { id: string; requestId: string } {
    // Throws "outside a request context" if ContextMiddleware did not run here.
    return { id, requestId: getContext().requestId };
  }
}

/**
 * Test-only module wiring ContextMiddleware with the SAME forRoutes(...)
 * pattern used by the real AppModule, so this test guards that production wiring.
 */
@Module({
  controllers: [CtxCheckController],
})
class CtxCheckModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Mirror AppModule's production wiring exactly. Under NestJS 11 +
    // Express 5, NestJS's LegacyRouteConverter auto-converts bare '*' to the
    // path-to-regexp v8 catch-all '{*path}' (with no deprecation warning), so
    // it correctly matches multi-segment/param routes like /ctxcheck/:id/detail.
    consumer.apply(ContextMiddleware).forRoutes('*');
  }
}

describe('ContextMiddleware on nested/param routes (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [CtxCheckModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /ctxcheck/123/detail → 200, sets X-Request-Id, and getContext() works in the handler', async () => {
    const res = await request(app.getHttpServer())
      .get('/ctxcheck/123/detail')
      .expect(200);

    // (a) response header present
    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    // (b) handler could call getContext() without throwing
    const body = res.body as { id: string; requestId: string };
    expect(body.id).toBe('123');
    expect(body.requestId).toBe(res.headers['x-request-id']);
  });
});
