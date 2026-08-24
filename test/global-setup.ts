import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

/**
 * Global e2e setup — runs once before all test suites.
 *
 * Guards on prisma/schema.prisma:
 * - Task 1: schema doesn't exist → no-op (no DB needed, health test only)
 * - Task 2+: schema exists → ensures test DB exists and migrations are current
 *
 * Cross-platform: uses `docker compose exec` (no grep/||) so it works on
 * both Windows and Unix without installing psql on the host.
 */
export default async function globalSetup() {
  const schemaPath = path.resolve(process.cwd(), 'prisma', 'schema.prisma');

  if (!fs.existsSync(schemaPath)) {
    // Task 1 state: no schema yet — nothing to set up
    return;
  }

  // Load test environment variables
  dotenv.config({ path: path.resolve(process.cwd(), '.env.test') });

  const { execSync } = await import('child_process');

  // Step 1: Ensure the DB container is up (idempotent)
  execSync('docker compose up -d db', {
    stdio: 'inherit',
    cwd: process.cwd(),
  });

  // Step 2: Wait for Postgres to accept connections (retry loop)
  const maxAttempts = 20;
  let ready = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      execSync('docker compose exec -T db pg_isready -U sentry', {
        stdio: 'pipe',
        cwd: process.cwd(),
      });
      ready = true;
      break;
    } catch {
      if (attempt === maxAttempts) {
        throw new Error('Postgres did not become ready in time');
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  if (!ready) {
    throw new Error('Postgres did not become ready');
  }

  // Step 3: Create the test database — ignore "already exists" error
  const dbUrl = process.env.DATABASE_URL ?? '';
  const dbName = new URL(dbUrl).pathname.slice(1); // strips leading '/'

  try {
    execSync(
      `docker compose exec -T db psql -U sentry -d postgres -c "CREATE DATABASE \\"${dbName}\\""`,
      { stdio: 'pipe', cwd: process.cwd() },
    );
  } catch (err: unknown) {
    // "already exists" (42P04) is expected on repeated runs — ignore it
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('already exists') && !msg.includes('42P04')) {
      throw err;
    }
  }

  // Step 4: Apply all pending migrations to the test database
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env },
    cwd: process.cwd(),
  });
}
