import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';
import { LockoutModule } from '../../common/lockout/lockout.module';
import { ApprovalService } from '../../pos/operators/approval.service';

/**
 * Stock feature module (tenant scope). Exports `StockService` — the single stock
 * mutator — so the POS surface (Task 19+) can reuse it behind its own guard
 * without going through the portal controller.
 */
@Module({
  imports: [AuthModule, LockoutModule],
  controllers: [StockController],
  providers: [StockService, ApprovalService],
  exports: [StockService],
})
export class StockModule {}
