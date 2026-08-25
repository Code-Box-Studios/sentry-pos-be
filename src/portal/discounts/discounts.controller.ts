import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Discount } from '@prisma/client';
import { PortalAuthGuard } from '../../auth/guards/portal-auth.guard';
import { DiscountsService } from './discounts.service';
import { CreateDiscountDto } from './dto/create-discount.dto';
import { UpdateDiscountDto } from './dto/update-discount.dto';

/**
 * Task 13 — portal discounts, gated by `PortalAuthGuard` (tenant scope).
 * `GET|POST /v1/portal/businesses/:businessId/discounts`,
 * `PATCH|DELETE /v1/portal/discounts/:id`.
 */
@Controller('portal')
@UseGuards(PortalAuthGuard)
export class DiscountsController {
  constructor(private readonly discounts: DiscountsService) {}

  @Get('businesses/:businessId/discounts')
  list(
    @Param('businessId', ParseUUIDPipe) businessId: string,
  ): Promise<Discount[]> {
    return this.discounts.list(businessId);
  }

  @Post('businesses/:businessId/discounts')
  create(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Body() dto: CreateDiscountDto,
  ): Promise<Discount> {
    return this.discounts.create(businessId, dto);
  }

  @Patch('discounts/:id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDiscountDto,
  ): Promise<Discount> {
    return this.discounts.update(id, dto);
  }

  @Delete('discounts/:id')
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<Discount> {
    return this.discounts.remove(id);
  }
}
