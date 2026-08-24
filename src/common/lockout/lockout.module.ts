import { Module } from '@nestjs/common';
import { LockoutService } from './lockout.service';

@Module({
  providers: [LockoutService],
  exports: [LockoutService],
})
export class LockoutModule {}
