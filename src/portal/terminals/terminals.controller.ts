import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { PortalAuthGuard } from '../../auth/guards/portal-auth.guard';
import { TerminalsService, TerminalResponse } from './terminals.service';
import { ManagerAccess } from '../../staff/portal-scope';

/**
 * Task 14 — portal terminals, gated by `PortalAuthGuard` (tenant scope).
 * `GET /v1/portal/businesses/:businessId/terminals`,
 * `POST /v1/portal/terminals/:id/unpair` (200 — mutates existing state).
 */
@Controller('portal')
@UseGuards(PortalAuthGuard)
export class TerminalsController {
  constructor(private readonly terminals: TerminalsService) {}

  @Get('businesses/:businessId/terminals')
  @ManagerAccess({ action: 'portal_terminals', businessParam: 'businessId' })
  list(
    @Param('businessId', ParseUUIDPipe) businessId: string,
  ): Promise<TerminalResponse[]> {
    return this.terminals.list(businessId);
  }

  @Post('terminals/:id/unpair')
  @ManagerAccess({ action: 'portal_terminals', terminalParam: 'id' })
  @HttpCode(HttpStatus.OK)
  unpair(@Param('id', ParseUUIDPipe) id: string): Promise<TerminalResponse> {
    return this.terminals.unpair(id);
  }
}
