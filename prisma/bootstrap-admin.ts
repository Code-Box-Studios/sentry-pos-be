/**
 * Creates the first platform admin — the one account that cannot be created through the API,
 * because every admin route sits behind `AdminGuard` and owners are only ever created by an
 * admin. Without this, a fresh production database has no way in: no admin, so no owner, so no
 * terminal can pair.
 *
 * `prisma/seed.ts` also creates one, but it refuses to run when NODE_ENV=production and it
 * truncates every table first, so it is not an option against a live database. This script
 * touches exactly one row and is safe to run against production.
 *
 * Idempotent: if a platform admin already exists it reports and exits without changing anything,
 * so an accidental second run cannot mint a second set of credentials.
 *
 *   BOOTSTRAP_ADMIN_EMAIL=you@example.com npx ts-node -r tsconfig-paths/register prisma/bootstrap-admin.ts
 *
 * The password is read from BOOTSTRAP_ADMIN_PASSWORD when set; otherwise a strong one is
 * generated and printed ONCE. TOTP enrols on first login — `totpSecret` stays null until then.
 */
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';
import { hashSecret } from '../src/auth/hashing';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) {
    console.error('BOOTSTRAP_ADMIN_EMAIL is required.');
    process.exit(1);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error(`Not a valid email address: ${email}`);
    process.exit(1);
  }

  const existing = await prisma.user.findFirst({
    where: { role: 'platform_admin', deletedAt: null },
    select: { email: true },
  });
  if (existing) {
    console.log(
      `A platform admin already exists (${existing.email}). Nothing to do.\n` +
        'Delete that row deliberately if you really mean to start over.',
    );
    return;
  }

  const taken = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (taken) {
    console.error(`A user with the email ${email} already exists, but is not a platform admin.`);
    process.exit(1);
  }

  const supplied = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (supplied && supplied.length < 12) {
    console.error('BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters.');
    process.exit(1);
  }
  const password = supplied ?? randomBytes(18).toString('base64url');

  await prisma.user.create({
    data: { email, role: 'platform_admin', passwordHash: await hashSecret(password) },
  });

  console.log('\n  Platform admin created.\n');
  console.log(`    email:    ${email}`);
  if (supplied) {
    console.log('    password: (the one you supplied)');
  } else {
    console.log(`    password: ${password}`);
    console.log('\n  This is shown once and is not recoverable — store it now.');
  }
  console.log('\n  TOTP enrols on first login. Sign in, then create owners from the admin API.\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
