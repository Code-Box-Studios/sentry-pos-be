import 'reflect-metadata';
import { validate } from './env.validation';
const local = {
  DATABASE_URL: 'postgresql://localhost/dev',
  DIRECT_URL: 'postgresql://localhost/dev',
  JWT_ACCESS_SECRET: 'dev-access-secret-change-me',
  JWT_REFRESH_SECRET: 'dev-refresh-secret-change-me',
  JWT_PAIRING_SECRET: 'dev-pairing-secret-change-me',
  CORS_ORIGINS: 'http://localhost:3000',
};
const production = {
  ...local,
  NODE_ENV: 'production',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  JWT_PAIRING_SECRET: 'c'.repeat(40),
  APP_URL: 'https://app.example.test',
  CORS_ORIGINS: 'https://pos.example.test',
  RESEND_API_KEY: 'test-provider-key',
  MAIL_FROM: 'Sentry <mail@example.test>',
  TENANT_STORAGE_BUCKET: 'images',
  TENANT_STORAGE_ENDPOINT: 'https://objects.example.test',
  TENANT_STORAGE_ACCESS_KEY_ID: 'key',
  TENANT_STORAGE_SECRET_ACCESS_KEY: 'secret',
};
describe('release environment validation', () => {
  it.each([
    'https://',
    'https://pos.example.test/',
    'https://pos.example.test/path',
    'https://user@pos.example.test',
    'https://pos.example.test?x=1',
  ])('rejects invalid browser origin %s', (origin) => {
    expect(() => validate({ ...production, CORS_ORIGINS: origin })).toThrow(
      /CORS_ORIGINS/,
    );
  });
  it('supports local development without hosted integrations', () => {
    expect(validate(local)).toBeDefined();
  });
  it('rejects incomplete object-storage configuration', () => {
    expect(() =>
      validate({ ...local, TENANT_STORAGE_BUCKET: 'images' }),
    ).toThrow(/TENANT_STORAGE/);
  });
  it('rejects development defaults in production', () => {
    expect(() => validate({ ...local, NODE_ENV: 'production' })).toThrow();
  });
  it('accepts fully configured production', () => {
    expect(validate(production)).toBeDefined();
  });
  it('allows production without provider credentials only when email is explicitly disabled', () => {
    const config = { ...production, RESEND_API_KEY: '', MAIL_FROM: '' };
    expect(() => validate(config)).toThrow(/RESEND_API_KEY/);
    expect(() => validate({ ...config, MAIL_ENABLED: 'true' })).toThrow(
      /RESEND_API_KEY/,
    );
    expect(validate({ ...config, MAIL_ENABLED: 'false' })).toBeDefined();
  });
  it('rejects an invalid email switch and keeps other production checks when email is disabled', () => {
    expect(() => validate({ ...production, MAIL_ENABLED: 'off' })).toThrow(
      /MAIL_ENABLED/,
    );
    expect(() =>
      validate({
        ...production,
        MAIL_ENABLED: 'false',
        JWT_ACCESS_SECRET: 'dev-access-secret-change-me',
      }),
    ).toThrow(/JWT/);
  });
});
