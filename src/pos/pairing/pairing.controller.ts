import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PairingService } from './pairing.service';
import type {
  BranchInfo,
  BusinessListItem,
  OwnerSession,
  PairResult,
} from './pairing.service';
import { PairingGuard, type RequestWithPairing } from '../guards/pairing.guard';
import { SignInDto } from './dto/sign-in.dto';
import { PairDto } from './dto/pair.dto';

/**
 * Task 16 — POS pairing. `sign-in` is public (owner credentials); the browse +
 * pair routes require the 10-min pairing token (PairingGuard).
 */
@Controller('pos/pairing')
export class PairingController {
  constructor(private readonly pairing: PairingService) {}

  @Post('sign-in')
  signIn(@Body() dto: SignInDto): Promise<OwnerSession> {
    return this.pairing.signIn(dto.email, dto.password);
  }

  @Get('businesses')
  @UseGuards(PairingGuard)
  businesses(@Req() req: RequestWithPairing): Promise<BusinessListItem[]> {
    return this.pairing.businesses(req.pairing.ownerId);
  }

  @Get('businesses/:id/branches')
  @UseGuards(PairingGuard)
  branches(
    @Req() req: RequestWithPairing,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BranchInfo[]> {
    return this.pairing.branches(req.pairing.ownerId, id);
  }

  @Post('pair')
  @UseGuards(PairingGuard)
  pair(
    @Req() req: RequestWithPairing,
    @Body() dto: PairDto,
  ): Promise<PairResult> {
    return this.pairing.pair(req.pairing.ownerId, req.pairing.userId, dto);
  }
}
