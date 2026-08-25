import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  UseGuards,
} from '@nestjs/common';
import { PairingService } from './pairing/pairing.service';
import { UnpairDto } from './pairing/dto/unpair.dto';
import { TerminalGuard } from './guards/terminal.guard';
import { getContext } from '../common/context/request-context';

interface TerminalSession {
  terminalCode: string | null;
  branchId: string | null;
  businessId: string | null;
  ownerId: string | null;
}

/**
 * Task 16 — POS root routes. `unpair` does its own device-token lookup + owner
 * re-auth (so a suspended owner can still offboard a device — NOT behind
 * TerminalGuard). `session` is the first TerminalGuard-protected route (a
 * whoami the device uses to confirm its pairing / context).
 */
@Controller('pos')
export class PosController {
  constructor(private readonly pairing: PairingService) {}

  @Post('unpair')
  unpair(
    @Headers('authorization') authHeader: string | undefined,
    @Body() dto: UnpairDto,
  ): Promise<{ ok: true }> {
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    return this.pairing.unpair(token, dto.email, dto.password);
  }

  @Get('session')
  @UseGuards(TerminalGuard)
  session(): TerminalSession {
    const ctx = getContext();
    return {
      terminalCode: ctx.terminalCode,
      branchId: ctx.branchId,
      businessId: ctx.businessId,
      ownerId: ctx.ownerId,
    };
  }
}
