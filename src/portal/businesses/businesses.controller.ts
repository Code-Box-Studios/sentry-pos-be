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
import { BusinessesService, BusinessResponse } from './businesses.service';
import { CreateBusinessDto } from './dto/create-business.dto';
import { UpdateBusinessDto } from './dto/update-business.dto';

/**
 * Task 11 — portal business management under `/v1/portal/businesses`, gated by
 * `PortalAuthGuard` (tenant scope). POST returns 201; PATCH/DELETE return 200
 * (DELETE returns the soft-archived row).
 */
@Controller('portal/businesses')
@UseGuards(PortalAuthGuard)
export class BusinessesController {
  constructor(private readonly businesses: BusinessesService) {}

  @Get()
  list(): Promise<BusinessResponse[]> {
    return this.businesses.list();
  }

  @Post()
  create(@Body() dto: CreateBusinessDto): Promise<BusinessResponse> {
    return this.businesses.create(dto);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<BusinessResponse> {
    return this.businesses.get(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBusinessDto,
  ): Promise<BusinessResponse> {
    return this.businesses.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<BusinessResponse> {
    return this.businesses.remove(id);
  }
}
