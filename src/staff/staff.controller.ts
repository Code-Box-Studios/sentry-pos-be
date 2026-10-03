import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { PortalAuthGuard } from '../auth/guards/portal-auth.guard';
import { CreateStaffDto, UpdateStaffDto } from './dto/staff.dto';
import { StaffService, StaffView } from './staff.service';

@Controller('portal/businesses/:businessId/staff')
@UseGuards(PortalAuthGuard)
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  list(
    @Param('businessId', ParseUUIDPipe) businessId: string,
  ): Promise<StaffView[]> {
    return this.staff.list(businessId);
  }

  @Post()
  create(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Body() dto: CreateStaffDto,
  ): Promise<{ staff: StaffView; temporaryPin?: string }> {
    return this.staff.create(businessId, dto);
  }

  @Get(':userId')
  get(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<StaffView> {
    return this.staff.get(businessId, userId);
  }

  @Patch(':userId')
  update(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateStaffDto,
  ): Promise<{ staff: StaffView; temporaryPin?: string }> {
    return this.staff.update(businessId, userId, dto);
  }

  @Post(':userId/reset-pin')
  @HttpCode(HttpStatus.OK)
  resetPin(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<{ staff: StaffView; temporaryPin?: string }> {
    return this.staff.resetPin(businessId, userId);
  }

  @Post(':userId/reset-password')
  @HttpCode(HttpStatus.OK)
  resetPassword(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<{ staff: StaffView; temporaryPin?: string }> {
    return this.staff.resetPassword(businessId, userId);
  }

  @Post(':userId/resend')
  @HttpCode(HttpStatus.OK)
  resend(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<{ staff: StaffView; temporaryPin?: string }> {
    return this.staff.resend(businessId, userId);
  }

  @Post(':userId/deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<StaffView> {
    return this.staff.deactivate(businessId, userId);
  }

  @Post(':userId/reactivate')
  @HttpCode(HttpStatus.OK)
  reactivate(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<{ staff: StaffView; temporaryPin?: string }> {
    return this.staff.reactivate(businessId, userId);
  }
}
