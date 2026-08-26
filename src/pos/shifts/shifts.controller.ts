import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { TerminalGuard } from '../guards/terminal.guard';
import {
  ShiftsService,
  type CashMovement,
  type ShiftTotals,
  type ShiftView,
  type ZReport,
} from './shifts.service';
import { OpenShiftDto } from './dto/open-shift.dto';
import { CashMovementDto } from './dto/cash-movement.dto';
import { CloseShiftDto } from './dto/close-shift.dto';

/**
 * Task 18 — POS shift routes (all TerminalGuard), mirroring the FE `PosApi`:
 * open a shift, record cash movements, read the live X totals, and close with a
 * Z-report. `current` is the terminal's single open shift (or null).
 */
@Controller('pos/shifts')
@UseGuards(TerminalGuard)
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  // `@Res` so a "no open shift" result is emitted as a literal JSON `null`
  // (a bare `return null` makes Nest's Express adapter send an empty body,
  // which a real client's `.json()` cannot parse). Body is `Shift | null`.
  @Get('current')
  async current(@Res() res: Response): Promise<void> {
    const shift = await this.shifts.current();
    res.status(200).json(shift);
  }

  @Post()
  open(@Body() dto: OpenShiftDto): Promise<ShiftView> {
    return this.shifts.open(dto);
  }

  @Post('current/cash-movements')
  addCashMovement(@Body() dto: CashMovementDto): Promise<CashMovement> {
    return this.shifts.addCashMovement(dto);
  }

  @Get('current/totals')
  totals(): Promise<ShiftTotals> {
    return this.shifts.totals();
  }

  @Post('current/close')
  @HttpCode(200)
  close(@Body() dto: CloseShiftDto): Promise<ZReport> {
    return this.shifts.close(dto);
  }
}
