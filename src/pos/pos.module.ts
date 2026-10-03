import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from '../auth/auth.module';
import { StockModule } from '../portal/stock/stock.module';
import { LockoutModule } from '../common/lockout/lockout.module';
import { PairingController } from './pairing/pairing.controller';
import { PairingService } from './pairing/pairing.service';
import { PosController } from './pos.controller';
import { PosCatalogController } from './catalog/pos-catalog.controller';
import { PosCatalogService } from './catalog/pos-catalog.service';
import { ShiftsController } from './shifts/shifts.controller';
import { ShiftsService } from './shifts/shifts.service';
import { SalesController } from './sales/sales.controller';
import { SalesService } from './sales/sales.service';
import { PosStockController } from './stock/pos-stock.controller';
import { PairingGuard } from './guards/pairing.guard';
import { TerminalGuard } from './guards/terminal.guard';
import { StaffModule } from '../staff/staff.module';
import { OperatorController } from './operators/operator.controller';
import {
  OperatorGuard,
  OptionalOperatorGuard,
} from './operators/operator.guard';
import { OperatorService } from './operators/operator.service';
import { ApprovalService } from './operators/approval.service';

/**
 * Task 16/17 — POS module: terminal pairing + guards + catalog pull. Imports
 * `AuthModule` for `AuthService` (owner credential check + pairing-token
 * minting), `JwtModule` for the PairingGuard's token verification, and
 * `StockModule` to reuse `StockService.levels` in the catalog pull. `PrismaService`
 * (raw) + `SCOPED_PRISMA` come from the global `PrismaModule`.
 */
@Module({
  imports: [
    AuthModule,
    JwtModule.register({}),
    StockModule,
    LockoutModule,
    StaffModule,
  ],
  controllers: [
    PairingController,
    PosController,
    PosCatalogController,
    ShiftsController,
    SalesController,
    PosStockController,
    OperatorController,
  ],
  providers: [
    PairingService,
    PairingGuard,
    TerminalGuard,
    OperatorGuard,
    OptionalOperatorGuard,
    OperatorService,
    ApprovalService,
    PosCatalogService,
    ShiftsService,
    SalesService,
  ],
})
export class PosModule {}
