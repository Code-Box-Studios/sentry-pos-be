import { NestFactory } from '@nestjs/core';
import { HttpStatus, ValidationPipe } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';
import { PrismaService } from './prisma/prisma.service';
import { buildOpenApiDocument } from './openapi';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Global prefix for all routes
  app.setGlobalPrefix('v1');

  // Global validation pipe — validation failures render as 422 `validation`.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
    }),
  );

  // Global exception filter — renders { code, message, ...extra, requestId } and
  // audits 403/423-class denials. Instantiated with the raw PrismaService from
  // the DI container so it can write denial audit rows.
  app.useGlobalFilters(new ApiExceptionFilter(app.get(PrismaService)));

  // CORS — origins from env (comma-separated list)
  const corsOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
    : [];
  app.enableCors({ origin: corsOrigins });

  // Swagger UI at /docs (non-production only). Stable operationIds so the FE can
  // generate a typed client whose method names match its PosApi.
  if (process.env.NODE_ENV !== 'production') {
    SwaggerModule.setup('docs', app, buildOpenApiDocument(app));
  }

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
  await app.listen(port);
}

void bootstrap();
