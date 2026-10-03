import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { PortalAuthGuard } from '../../auth/guards/portal-auth.guard';
import { LifecycleService } from './lifecycle.service';
import { CloseAccountDto, ResetDemoDto } from './lifecycle.dto';
@Controller('portal')
@UseGuards(PortalAuthGuard)
export class LifecycleController {
  constructor(private readonly lifecycle: LifecycleService) {}
  @Get('account/export')
  async export(@Res() response: Response) {
    const result = await this.lifecycle.export();
    response.setHeader('Content-Type', 'application/zip');
    response.setHeader(
      'Content-Disposition',
      'attachment; filename="sentry-account-export.zip"',
    );
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Export-Id', result.id);
    response.send(result.zip);
  }
  @Post('account/closure')
  close(@Body() dto: CloseAccountDto) {
    return this.lifecycle.close(dto);
  }
  @Post('businesses/:id/demo-reset')
  reset(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResetDemoDto) {
    return this.lifecycle.resetDemo(id, dto);
  }
}
