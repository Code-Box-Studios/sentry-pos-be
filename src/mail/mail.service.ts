import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
}

const DEFAULT_FROM = 'Sentry <no-reply@sentrypos.local>';

/**
 * Task 9 — outbound transactional mail (invites + password reset).
 *
 * When `RESEND_API_KEY` is set, mail is delivered through Resend. Otherwise a
 * console-logger transport is used: the message is logged and appended to the
 * in-memory `sentMailbox` array so dev tooling and e2e tests can read the last
 * message (and extract the raw invite/reset token from its body).
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly resend: Resend | null;
  private readonly from: string;

  /**
   * Console-transport outbox. Holds every message the console transport
   * "sent", in order; tests read `sentMailbox[0]` / clear it between cases.
   * Only populated when Resend is NOT configured.
   */
  readonly sentMailbox: MailMessage[] = [];

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('RESEND_API_KEY');
    this.from = config.get<string>('MAIL_FROM') ?? DEFAULT_FROM;
    this.resend = apiKey ? new Resend(apiKey) : null;
  }

  /** True when the Resend transport is active (RESEND_API_KEY was set). */
  get usingResend(): boolean {
    return this.resend !== null;
  }

  async send(message: MailMessage): Promise<void> {
    if (this.resend) {
      await this.resend.emails.send({
        from: this.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
      });
      return;
    }

    // Console-logger transport (dev/tests): log + capture.
    this.sentMailbox.push(message);
    this.logger.log(
      `[mail:console] to=${message.to} subject=${JSON.stringify(
        message.subject,
      )}`,
    );
  }
}
