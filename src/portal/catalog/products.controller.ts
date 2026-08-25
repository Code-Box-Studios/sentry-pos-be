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
import { PortalAuthGuard } from '../../auth/guards/portal-auth.guard';
import { ProductsService, ProductResponse } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

/**
 * Task 12 — portal products (+ nested variants), gated by `PortalAuthGuard`
 * (tenant scope). `GET|POST /v1/portal/businesses/:businessId/products`,
 * `GET|PATCH|DELETE /v1/portal/products/:id`.
 */
@Controller('portal')
@UseGuards(PortalAuthGuard)
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get('businesses/:businessId/products')
  list(
    @Param('businessId', ParseUUIDPipe) businessId: string,
  ): Promise<ProductResponse[]> {
    return this.products.list(businessId);
  }

  @Post('businesses/:businessId/products')
  create(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Body() dto: CreateProductDto,
  ): Promise<ProductResponse> {
    return this.products.create(businessId, dto);
  }

  @Get('products/:id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<ProductResponse> {
    return this.products.get(id);
  }

  @Patch('products/:id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
  ): Promise<ProductResponse> {
    return this.products.update(id, dto);
  }

  @Delete('products/:id')
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<ProductResponse> {
    return this.products.remove(id);
  }
}
