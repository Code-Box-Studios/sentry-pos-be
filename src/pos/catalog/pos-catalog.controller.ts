import { Controller, Get, UseGuards } from '@nestjs/common';
import { TerminalGuard } from '../guards/terminal.guard';
import { PosCatalogService, type CatalogPayload } from './pos-catalog.service';

/**
 * Task 17 — `GET /v1/pos/catalog`. TerminalGuard authenticates the device token
 * and stamps the terminal's tenant scope; the service then returns the whole
 * FE `CatalogPayload` (active products/discounts only, costs excluded).
 */
@Controller('pos/catalog')
@UseGuards(TerminalGuard)
export class PosCatalogController {
  constructor(private readonly catalog: PosCatalogService) {}

  @Get()
  pull(): Promise<CatalogPayload> {
    return this.catalog.pull();
  }
}
