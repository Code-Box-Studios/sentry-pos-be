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
import { Branch } from '@prisma/client';
import { PortalAuthGuard } from '../../auth/guards/portal-auth.guard';
import { BranchesService } from './branches.service';
import { CreateBranchDto } from './dto/create-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';

/**
 * Task 11 — portal branch management, gated by `PortalAuthGuard` (tenant scope).
 * List/create are nested under the parent business; get/patch/delete address a
 * branch directly by id. Routes: `GET|POST /v1/portal/businesses/:businessId/branches`,
 * `GET|PATCH|DELETE /v1/portal/branches/:id`.
 */
@Controller('portal')
@UseGuards(PortalAuthGuard)
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Get('businesses/:businessId/branches')
  list(
    @Param('businessId', ParseUUIDPipe) businessId: string,
  ): Promise<Branch[]> {
    return this.branches.list(businessId);
  }

  @Post('businesses/:businessId/branches')
  create(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Body() dto: CreateBranchDto,
  ): Promise<Branch> {
    return this.branches.create(businessId, dto);
  }

  @Get('branches/:id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<Branch> {
    return this.branches.get(id);
  }

  @Patch('branches/:id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBranchDto,
  ): Promise<Branch> {
    return this.branches.update(id, dto);
  }

  @Delete('branches/:id')
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<Branch> {
    return this.branches.remove(id);
  }
}
