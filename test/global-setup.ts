import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

/**
 * Global e2e setup — runs once before all test suites.
 *
 * Guards on prisma/schema.prisma:
 * - Task 1: schema doesn't exist → no-op (no DB needed, health test only)
 * - Task 2+: schema exists → ensures test DB exists and migrations are current
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

  // Ensure test database exists
  const dbUrl = process.env.DATABASE_URL ?? '';
  const dbName = new URL(dbUrl).pathname.slice(1); // strips leading '/'
  const adminUrl = dbUrl.replace(`/${dbName}`, '/postgres');

  try {
    execSync(
      `psql "${adminUrl}" -c "SELECT 1 FROM pg_database WHERE datname='${dbName}'" | grep -q 1 || psql "${adminUrl}" -c "CREATE DATABASE \\"${dbName}\\""`,
      { stdio: 'inherit' },
    );
  } catch {
    // Database may already exist — continue
  }

  // Run migrations against the test database
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env },
  });
}
