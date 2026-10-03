import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { PortalAuthGuard } from '../auth/guards/portal-auth.guard';
import { NotificationsService } from './notifications.service';

export class NotificationQuery {
  @IsOptional() @IsIn(['true', 'false']) unreadOnly?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
}

@Controller('portal/notifications')
@UseGuards(PortalAuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Query() query: NotificationQuery) {
    return this.notifications.list(
      query.page,
      query.pageSize,
      query.unreadOnly === 'true',
    );
  }

  @Post('read-all')
  @HttpCode(200)
  readAll() {
    return this.notifications.readAll();
  }

  @Post(':id/read')
  @HttpCode(200)
  read(@Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.read(id);
  }
}
