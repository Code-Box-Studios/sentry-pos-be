import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { getContext } from '../../common/context/request-context';
import { TerminalGuard } from '../guards/terminal.guard';
import { SetupOperatorPinDto, UnlockOperatorDto } from './dto/operator.dto';
import { OperatorGuard } from './operator.guard';
import {
  OperatorIdentity,
  OperatorService,
  OperatorUnlock,
} from './operator.service';

@Controller('pos/operators')
@UseGuards(TerminalGuard)
export class OperatorController {
  constructor(private readonly operators: OperatorService) {}

  @Get()
  roster(): Promise<(OperatorIdentity & { requiresSetup: boolean })[]> {
    return this.operators.roster();
  }

  @Post('unlock')
  unlock(@Body() dto: UnlockOperatorDto): Promise<OperatorUnlock> {
    return this.operators.unlock(dto);
  }

  @Post('setup-pin')
  setupPin(@Body() dto: SetupOperatorPinDto): Promise<OperatorUnlock> {
    return this.operators.setupPin(dto);
  }

  @Get('current')
  @UseGuards(OperatorGuard)
  current(): OperatorIdentity | undefined {
    return getContext().operator;
  }

  @Get('activity')
  @UseGuards(OperatorGuard)
  activity() {
    return this.operators.activity();
  }

  @Post('lock')
  @HttpCode(200)
  @UseGuards(OperatorGuard)
  lock(): Promise<{ ok: true }> {
    return this.operators.lock();
  }
}
