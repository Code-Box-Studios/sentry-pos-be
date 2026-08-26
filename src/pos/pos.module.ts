import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from '../auth/auth.module';
import { StockModule } from '../portal/stock/stock.module';
import { PairingController } from './pairing/pairing.controller';
import { PairingService } from './pairing/pairing.service';
import { PosController } from './pos.controller';
import { PosCatalogController } from './catalog/pos-catalog.controller';
import { PosCatalogService } from './catalog/pos-catalog.service';
import { ShiftsController } from './shifts/shifts.controller';
import { ShiftsService } from './shifts/shifts.service';
import { PairingGuard } from './guards/pairing.guard';
import { TerminalGuard } from './guards/terminal.guard';

/**
 * Task 16/17 — POS module: terminal pairing + guards + catalog pull. Imports
 * `AuthModule` for `AuthService` (owner credential check + pairing-token
 * minting), `JwtModule` for the PairingGuard's token verification, and
 * `StockModule` to reuse `StockService.levels` in the catalog pull. `PrismaService`
 * (raw) + `SCOPED_PRISMA` come from the global `PrismaModule`.
 */
@Module({
  imports: [AuthModule, JwtModule.register({}), StockModule],
  controllers: [
    PairingController,
    PosController,
    PosCatalogController,
    ShiftsController,
  ],
  providers: [
    PairingService,
    PairingGuard,
    TerminalGuard,
    PosCatalogService,
    ShiftsService,
  ],
})
export class PosModule {}
