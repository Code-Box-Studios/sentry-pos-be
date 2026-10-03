import { Body, Controller, Post } from '@nestjs/common';
import { SetupManagerDto, SetupPasswordDto } from './dto/staff.dto';
import { StaffSetupService } from './staff-setup.service';

@Controller('auth/staff')
export class StaffSetupController {
  constructor(private readonly setup: StaffSetupService) {}

  @Post('setup-manager')
  setupManager(@Body() dto: SetupManagerDto) {
    return this.setup.setupManager(dto);
  }

  @Post('setup-password')
  setupPassword(@Body() dto: SetupPasswordDto) {
    return this.setup.setupPassword(dto);
  }
}
