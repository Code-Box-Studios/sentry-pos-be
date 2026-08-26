import { NestFactory } from '@nestjs/core';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { AppModule } from '../src/app.module';
import { buildOpenApiDocument } from '../src/openapi';

/**
 * Emits `openapi.json` at the repo root for the FE's `openapi-typescript` step.
 * Run with `npm run openapi:emit`. Builds the document with the `/v1` prefix and
 * the FE-named operationIds.
 *
 * NOTE: `app.init()` runs `PrismaService.onModuleInit` → `$connect()`, so a
 * reachable database is required — run `npm run db:up` first. (The route
 * introspection itself is static; it's the app lifecycle that opens the
 * connection.)
 */
async function emit(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  try {
    app.setGlobalPrefix('v1');
    await app.init();

    const document = buildOpenApiDocument(app);
    const outPath = join(process.cwd(), 'openapi.json');
    writeFileSync(outPath, JSON.stringify(document, null, 2));

    const opCount = Object.values(document.paths).reduce(
      (n, item) => n + Object.keys(item).length,
      0,
    );
    console.log(`Wrote ${outPath} (${opCount} operations).`);
  } finally {
    await app.close();
  }
}

void emit();
