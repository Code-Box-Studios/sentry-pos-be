import { Body, Controller, Put, UseGuards } from '@nestjs/common';
import { PortalAuthGuard } from '../../auth/guards/portal-auth.guard';
import { SettingsService } from './settings.service';
import { SetRefundPinDto } from './dto/set-refund-pin.dto';

/**
 * Task 14 — portal settings, gated by `PortalAuthGuard` (tenant scope).
 * `PUT /v1/portal/refund-pin`. (Business settings ride PATCH /businesses/:id.)
 */
@Controller('portal')
@UseGuards(PortalAuthGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Put('refund-pin')
  setRefundPin(@Body() dto: SetRefundPinDto): Promise<{ ok: true }> {
    return this.settings.setRefundPin(dto.pin);
  }
}
