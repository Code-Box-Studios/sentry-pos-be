import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from '../auth/auth.module';
import { PairingController } from './pairing/pairing.controller';
import { PairingService } from './pairing/pairing.service';
import { PosController } from './pos.controller';
import { PairingGuard } from './guards/pairing.guard';
import { TerminalGuard } from './guards/terminal.guard';

/**
 * Task 16 — POS module: terminal pairing + guards. Imports `AuthModule` for
 * `AuthService` (owner credential check + pairing-token minting) and registers
 * `JwtModule` for the PairingGuard's token verification. `PrismaService` (raw)
 * comes from the global `PrismaModule`.
 */
@Module({
  imports: [AuthModule, JwtModule.register({})],
  controllers: [PairingController, PosController],
  providers: [PairingService, PairingGuard, TerminalGuard],
})
export class PosModule {}
