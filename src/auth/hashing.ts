import * as argon2 from 'argon2';

/**
 * Hashes a plaintext secret (password or PIN) using argon2id.
 */
export async function hashSecret(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

/**
 * Verifies a plaintext secret against an argon2id hash.
 * Returns true if they match, false otherwise.
 */
export async function verifySecret(
  hash: string,
  plain: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
