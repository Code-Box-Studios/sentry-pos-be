import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StaffChallengeService } from './staff-challenge.service';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';
import { StaffSetupController } from './staff-setup.controller';
import { StaffSetupService } from './staff-setup.service';
import { ManagerContextController } from './manager-context.controller';

@Module({
  imports: [AuthModule],
  controllers: [
    StaffController,
    StaffSetupController,
    ManagerContextController,
  ],
  providers: [StaffChallengeService, StaffService, StaffSetupService],
  exports: [StaffChallengeService],
})
export class StaffModule {}
