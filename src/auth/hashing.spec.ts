import { hashSecret, verifySecret } from './hashing';

describe('hashing (argon2id)', () => {
  it('hashSecret produces a string that is not equal to the plaintext', async () => {
    const plain = 'super-secret-password';
    const hash = await hashSecret(plain);
    expect(typeof hash).toBe('string');
    expect(hash).not.toBe(plain);
  });

  it('hashSecret produces different hashes for the same input (salted)', async () => {
    const plain = 'same-password';
    const hash1 = await hashSecret(plain);
    const hash2 = await hashSecret(plain);
    expect(hash1).not.toBe(hash2);
  });

  it('hashSecret output starts with argon2id identifier', async () => {
    const hash = await hashSecret('password123');
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it('verifySecret returns true when plain matches the hash', async () => {
    const plain = 'correct-horse-battery-staple';
    const hash = await hashSecret(plain);
    const result = await verifySecret(hash, plain);
    expect(result).toBe(true);
  });

  it('verifySecret returns false when plain does NOT match the hash', async () => {
    const plain = 'correct-horse-battery-staple';
    const hash = await hashSecret(plain);
    const result = await verifySecret(hash, 'wrong-password');
    expect(result).toBe(false);
  });

  it('verifySecret returns false for a garbage hash string', async () => {
    const result = await verifySecret('not-a-valid-hash', 'password');
    expect(result).toBe(false);
  });
});
