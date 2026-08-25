import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Owner } from '@prisma/client';
import { AdminGuard } from '../auth/guards/admin.guard';
import { OwnersService } from './owners.service';
import { CreateOwnerDto } from './dto/create-owner.dto';
import { UpdateOwnerDto } from './dto/update-owner.dto';
import { SuspendOwnerDto } from './dto/suspend-owner.dto';

/**
 * Task 10 — platform-admin owner management. Every route is gated by
 * `AdminGuard`, which verifies the access JWT, requires `role: platform_admin`,
 * and stamps the platform scope onto the RequestContext. POST routes return 201
 * (Nest default); PATCH returns 200.
 */
@Controller('admin/owners')
@UseGuards(AdminGuard)
export class OwnersController {
  constructor(private readonly owners: OwnersService) {}

  @Get()
  list(): Promise<Owner[]> {
    return this.owners.list();
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<Owner> {
    return this.owners.get(id);
  }

  @Post()
  create(@Body() dto: CreateOwnerDto): Promise<Owner> {
    return this.owners.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOwnerDto,
  ): Promise<Owner> {
    return this.owners.update(id, dto);
  }

  @Post(':id/suspend')
  suspend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SuspendOwnerDto,
  ): Promise<Owner> {
    return this.owners.suspend(id, dto);
  }

  @Post(':id/reinstate')
  reinstate(@Param('id', ParseUUIDPipe) id: string): Promise<Owner> {
    return this.owners.reinstate(id);
  }
}
