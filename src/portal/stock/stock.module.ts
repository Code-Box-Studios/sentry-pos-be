import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';

/**
 * Stock feature module (tenant scope). Exports `StockService` — the single stock
 * mutator — so the POS surface (Task 19+) can reuse it behind its own guard
 * without going through the portal controller.
 */
@Module({
  imports: [AuthModule],
  controllers: [StockController],
  providers: [StockService],
  exports: [StockService],
})
export class StockModule {}
