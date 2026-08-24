import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';

/**
 * Task 9 — mail transport (Resend or console). Global so any feature module can
 * inject MailService without importing MailModule explicitly.
 */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
