import { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';

/**
 * Task 21 — stable `operationId`s named after the FE `PosApi` methods, so a
 * client generated from `openapi.json` (via `openapi-typescript`) has method
 * names that line up 1:1 with the FE adapter. Keyed by `${ControllerClass}.${method}`.
 */
export const POS_OPERATION_IDS: Record<string, string> = {
  'PairingController.signIn': 'ownerSignIn',
  'PairingController.businesses': 'listBusinesses',
  'PairingController.branches': 'listBranches',
  'PairingController.pair': 'pairTerminal',
  'PosController.unpair': 'unpair',
  'HealthController.check': 'health',
  'PosCatalogController.pull': 'pullCatalog',
  'ShiftsController.current': 'getCurrentShift',
  'ShiftsController.open': 'openShift',
  'ShiftsController.addCashMovement': 'addCashMovement',
  'ShiftsController.totals': 'getShiftTotals',
  'ShiftsController.close': 'closeShift',
  'SalesController.completeSale': 'completeSale',
  'SalesController.listSales': 'listSales',
  'SalesController.getSale': 'getSale',
  'SalesController.voidSale': 'voidSale',
  'SalesController.refundSale': 'refundSale',
  'PosStockController.getStock': 'getStockLevels',
  'PosStockController.adjust': 'adjustStock',
};

/** The 19 FE-facing operationIds the generated client must expose. */
export const POS_OPERATION_ID_VALUES: readonly string[] =
  Object.values(POS_OPERATION_IDS);

/**
 * Build the OpenAPI document for the running app. Shared by `main.ts` (the
 * `/docs` UI), `scripts/emit-openapi.ts` (writes `openapi.json`), and the
 * contract e2e (asserts every operationId is present). Call AFTER
 * `setGlobalPrefix('v1')` so the emitted paths carry the `/v1` prefix.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Sentry POS API')
    .setDescription('POS terminal, portal, and platform-admin API.')
    .setVersion('1.0.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'token' },
      'device-token',
    )
    .build();

  return SwaggerModule.createDocument(app, config, {
    operationIdFactory: (controllerKey, methodKey) =>
      POS_OPERATION_IDS[`${controllerKey}.${methodKey}`] ??
      `${controllerKey}_${methodKey}`,
  });
}
