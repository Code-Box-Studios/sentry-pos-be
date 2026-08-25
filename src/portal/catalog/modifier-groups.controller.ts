import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { PortalAuthGuard } from '../../auth/guards/portal-auth.guard';
import {
  ModifierGroupsService,
  ModifierGroupResponse,
  ProductGroupLinks,
} from './modifier-groups.service';
import { CreateModifierGroupDto } from './dto/create-modifier-group.dto';
import { UpdateModifierGroupDto } from './dto/update-modifier-group.dto';
import { SetProductModifierGroupsDto } from './dto/set-product-modifier-groups.dto';

/**
 * Task 13 — portal modifier groups + product↔group links, gated by
 * `PortalAuthGuard` (tenant scope).
 * `GET|POST /v1/portal/businesses/:businessId/modifier-groups`,
 * `PATCH|DELETE /v1/portal/modifier-groups/:id`,
 * `PUT /v1/portal/products/:id/modifier-groups` (replace the link set).
 */
@Controller('portal')
@UseGuards(PortalAuthGuard)
export class ModifierGroupsController {
  constructor(private readonly groups: ModifierGroupsService) {}

  @Get('businesses/:businessId/modifier-groups')
  list(
    @Param('businessId', ParseUUIDPipe) businessId: string,
  ): Promise<ModifierGroupResponse[]> {
    return this.groups.list(businessId);
  }

  @Post('businesses/:businessId/modifier-groups')
  create(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Body() dto: CreateModifierGroupDto,
  ): Promise<ModifierGroupResponse> {
    return this.groups.create(businessId, dto);
  }

  @Patch('modifier-groups/:id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateModifierGroupDto,
  ): Promise<ModifierGroupResponse> {
    return this.groups.update(id, dto);
  }

  @Delete('modifier-groups/:id')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ModifierGroupResponse> {
    return this.groups.remove(id);
  }

  @Put('products/:id/modifier-groups')
  setProductGroups(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetProductModifierGroupsDto,
  ): Promise<ProductGroupLinks> {
    return this.groups.setProductGroups(id, dto.groupIds);
  }
}
