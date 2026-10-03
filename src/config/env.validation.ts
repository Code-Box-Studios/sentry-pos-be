import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
  validateSync,
} from 'class-validator';

enum Environment {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

class EnvironmentVariables {
  @IsString()
  DATABASE_URL!: string;

  @IsString()
  DIRECT_URL!: string;

  @IsString()
  @MinLength(16)
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @MinLength(16)
  JWT_REFRESH_SECRET!: string;

  @IsString()
  @MinLength(16)
  JWT_PAIRING_SECRET!: string;

  @IsString()
  CORS_ORIGINS!: string;

  @IsOptional()
  @IsString()
  RESEND_API_KEY?: string;

  @IsOptional()
  @IsString()
  MAIL_FROM?: string;

  @IsOptional()
  @IsInt()
  PORT?: number;

  @IsOptional()
  @IsEnum(Environment)
  NODE_ENV?: Environment;
}

export function validate(config: Record<string, unknown>) {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new Error(errors.toString());
  }

  const storageKeys = [
    'TENANT_STORAGE_BUCKET',
    'TENANT_STORAGE_ENDPOINT',
    'TENANT_STORAGE_ACCESS_KEY_ID',
    'TENANT_STORAGE_SECRET_ACCESS_KEY',
  ];
  const text = (key: string) =>
    typeof config[key] === 'string' ? config[key].trim() : '';
  const production = config.NODE_ENV === Environment.Production;
  if (
    text('MAIL_ENABLED') &&
    !['true', 'false'].includes(text('MAIL_ENABLED'))
  ) {
    throw new Error('MAIL_ENABLED must be true or false.');
  }
  if (
    (production || storageKeys.some((key) => text(key))) &&
    !storageKeys.every((key) => text(key))
  ) {
    throw new Error(
      `Configure all TENANT_STORAGE settings: ${storageKeys.join(', ')}`,
    );
  }
  if (production) {
    const secrets = [
      'JWT_ACCESS_SECRET',
      'JWT_REFRESH_SECRET',
      'JWT_PAIRING_SECRET',
    ].map(text);
    if (
      secrets.some(
        (value) => value.length < 32 || /dev-|change-me/i.test(value),
      ) ||
      new Set(secrets).size !== secrets.length
    ) {
      throw new Error(
        'Production JWT secrets must be distinct, generated values of at least 32 characters.',
      );
    }
    for (const key of ['APP_URL', 'TENANT_STORAGE_ENDPOINT']) {
      if (!text(key).startsWith('https://'))
        throw new Error(`${key} must use HTTPS in production.`);
      new URL(text(key));
    }
    if (
      !text('CORS_ORIGINS') ||
      text('CORS_ORIGINS')
        .split(',')
        .some((origin) => {
          try {
            const value = origin.trim();
            const url = new URL(value);
            return (
              url.protocol !== 'https:' ||
              url.origin !== value ||
              value.includes('*')
            );
          } catch {
            return true;
          }
        })
    ) {
      throw new Error(
        'CORS_ORIGINS must list explicit HTTPS origins in production.',
      );
    }
    if (
      text('MAIL_ENABLED') !== 'false' &&
      (!text('RESEND_API_KEY') || !text('MAIL_FROM'))
    )
      throw new Error(
        'RESEND_API_KEY and MAIL_FROM are required in production unless MAIL_ENABLED=false.',
      );
  }

  return validatedConfig;
}
