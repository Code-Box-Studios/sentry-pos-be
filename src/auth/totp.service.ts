import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { generateSecret, generateSync, generateURI, verifySync } from 'otplib';
import { PrismaService } from '../prisma/prisma.service';
import { hashSecret, verifySecret } from './hashing';
import { TotpInvalidError } from '../common/errors/api-errors';

const RECOVERY_CODE_COUNT = 8;
const RECOVERY_CODE_BYTES = 10; // 20 hex chars per code
const ISSUER = 'Sentry POS';

/**
 * TOTP enrollment and verification (Task 8).
 *
 * Uses otplib 13.x functional API (RFC 6238 TOTP, SHA-1 HMAC, 30-second window).
 * Verification uses a ±1 step tolerance (window: 1) to handle minor clock skew.
 *
 * Recovery codes are random 20-char hex strings stored as argon2id hashes;
 * they are single-use — the matching hash is removed from `totpRecoveryCodes`
 * on successful use.
 *
 * The PENDING pattern: `generateSetup` writes the new secret to
 * `totpPendingSecret` (NOT `totpSecret`), so Task 7's login branch remains
 * correct: `totpSecret == null` ⇒ `totpSetupRequired` until `enableTotp`
 * completes.
 */
@Injectable()
export class TotpService {
  constructor(private readonly raw: PrismaService) {}

  /**
   * Generate a new TOTP secret and store it as PENDING (not enrolled).
   * The pending secret does NOT affect Task 7's `totpSecret == null` check,
   * so login correctly continues to return `totpSetupRequired` until `enable`
   * is called.
   *
   * Returns the raw secret and an otpauth URI for QR-code display.
   */
  async generateSetup(
    userId: string,
  ): Promise<{ secret: string; otpauthUri: string }> {
    const user = await this.raw.user.findUniqueOrThrow({
      where: { id: userId },
    });

    const secret = generateSecret();
    const otpauthUri = generateURI({
      label: user.email,
      issuer: ISSUER,
      secret,
      digits: 6,
      period: 30,
    });

    await this.raw.user.update({
      where: { id: userId },
      data: { totpPendingSecret: secret },
    });

    return { secret, otpauthUri };
  }

  /**
   * Verify `code` against the pending secret, then activate TOTP:
   * - Moves `totpPendingSecret` → `totpSecret`
   * - Generates 8 one-time recovery codes (plaintext returned once, hashed at rest)
   *
   * Throws `TotpInvalidError` if the code is wrong or there is no pending secret.
   */
  async enableTotp(
    userId: string,
    code: string,
  ): Promise<{ recoveryCodes: string[] }> {
    const user = await this.raw.user.findUniqueOrThrow({
      where: { id: userId },
    });

    if (!user.totpPendingSecret) {
      throw new TotpInvalidError();
    }

    // Verify against pending secret with ±1 window
    const result = verifySync({
      token: code,
      secret: user.totpPendingSecret,
      epochTolerance: 30,
    });

    if (!result.valid) {
      throw new TotpInvalidError();
    }

    // Generate 8 plaintext recovery codes
    const plainCodes: string[] = Array.from(
      { length: RECOVERY_CODE_COUNT },
      () => randomBytes(RECOVERY_CODE_BYTES).toString('hex'),
    );

    // Hash each code for storage (argon2id)
    const hashedCodes = await Promise.all(plainCodes.map((c) => hashSecret(c)));

    // Activate: move pending → active, store hashed codes
    await this.raw.user.update({
      where: { id: userId },
      data: {
        totpSecret: user.totpPendingSecret,
        totpPendingSecret: null,
        totpRecoveryCodes: hashedCodes,
      },
    });

    return { recoveryCodes: plainCodes };
  }

  /**
   * Verify a TOTP code OR a recovery code against the enrolled user.
   * Recovery codes are single-use: the matching hash is removed on success.
   *
   * Throws `TotpInvalidError` if neither a TOTP code nor a recovery code matches.
   */
  async verifyTotp(userId: string, code: string): Promise<void> {
    const user = await this.raw.user.findUniqueOrThrow({
      where: { id: userId },
    });

    if (!user.totpSecret) {
      throw new TotpInvalidError();
    }

    // Try TOTP code first (±1 step / epochTolerance 30s tolerates minor clock skew).
    // verifySync throws TokenLengthError/TokenFormatError for non-6-digit tokens
    // (e.g. recovery codes that are 20 hex chars) — treat any such error as "not a
    // TOTP code" and fall through to recovery code verification.
    try {
      const totpResult = verifySync({
        token: code,
        secret: user.totpSecret,
        epochTolerance: 30,
      });

      if (totpResult.valid) {
        return; // success — TOTP code matched
      }
    } catch {
      // Not a valid TOTP token format — fall through to recovery code check
    }

    // Try recovery codes in sequence
    const hashes = user.totpRecoveryCodes;
    for (let i = 0; i < hashes.length; i++) {
      const match = await verifySecret(hashes[i], code);
      if (match) {
        // Consume: remove matching hash from the array (single-use)
        const remaining = [...hashes.slice(0, i), ...hashes.slice(i + 1)];
        await this.raw.user.update({
          where: { id: userId },
          data: { totpRecoveryCodes: remaining },
        });
        return; // success — recovery code matched and consumed
      }
    }

    throw new TotpInvalidError();
  }

  /**
   * Helper used in tests: generate a TOTP code for a given secret.
   * Delegates to otplib's generateSync functional API.
   */
  static generateTokenSync(secret: string): string {
    return generateSync({ secret });
  }
}
