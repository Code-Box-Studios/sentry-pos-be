import * as path from 'path';
import * as dotenv from 'dotenv';

// Load test environment variables before each test file
dotenv.config({ path: path.resolve(process.cwd(), '.env.test') });
