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
import { Category } from '@prisma/client';
import { PortalAuthGuard } from '../../auth/guards/portal-auth.guard';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

/**
 * Task 12 — portal categories, gated by `PortalAuthGuard` (tenant scope).
 * `GET|POST /v1/portal/businesses/:businessId/categories`,
 * `PATCH|DELETE /v1/portal/categories/:id`.
 */
@Controller('portal')
@UseGuards(PortalAuthGuard)
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get('businesses/:businessId/categories')
  list(
    @Param('businessId', ParseUUIDPipe) businessId: string,
  ): Promise<Category[]> {
    return this.categories.list(businessId);
  }

  @Post('businesses/:businessId/categories')
  create(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Body() dto: CreateCategoryDto,
  ): Promise<Category> {
    return this.categories.create(businessId, dto);
  }

  @Patch('categories/:id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
  ): Promise<Category> {
    return this.categories.update(id, dto);
  }

  @Delete('categories/:id')
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<Category> {
    return this.categories.remove(id);
  }
}
