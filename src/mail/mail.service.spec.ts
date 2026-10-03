import { ConfigService } from '@nestjs/config';
import { MailService } from './mail.service';
const send = jest.fn();
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send } })),
}));

test('provider failures propagate and retries carry a stable idempotency key', async () => {
  send.mockResolvedValue({ data: null, error: { message: 'quota exhausted' } });
  const mail = new MailService(
    new ConfigService({ RESEND_API_KEY: 'test-only' }),
  );
  const message = {
    to: 'owner@example.test',
    subject: 'Summary',
    html: '<p>Summary</p>',
    idempotencyKey: 'daily:test',
  };
  await expect(mail.send(message)).rejects.toThrow('quota exhausted');
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ to: message.to }),
    { idempotencyKey: message.idempotencyKey },
  );
});

test.each([undefined, 'test-only'])(
  'disabled email neither contacts a provider nor captures messages (key=%s)',
  async (apiKey) => {
    send.mockClear();
    const mail = new MailService(
      new ConfigService({ MAIL_ENABLED: 'false', RESEND_API_KEY: apiKey }),
    );
    await mail.send({
      to: 'owner@example.test',
      subject: 'Invite',
      html: '<p>Private invite</p>',
    });
    expect(mail.usingResend).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(mail.sentMailbox).toEqual([]);
  },
);
