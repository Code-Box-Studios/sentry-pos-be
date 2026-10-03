import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationJobsService } from './notification-jobs.service';

@Module({
  imports: [AuthModule, MailModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationJobsService],
  exports: [NotificationJobsService],
})
export class NotificationsModule {}
