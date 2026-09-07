// Minimal .env loader for the e2e jest project — no dotenv dependency.
// Mirrors what `node --env-file=.env` does for start:dev, so e2e tests
// see the same config. Existing process.env values win. Runs before the
// AppModule (and its env.ts parse-on-import) is loaded by any test file.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envPath = resolve(__dirname, '..', '.env');

if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// e2e always runs against the dedicated triage_test database created by
// `pnpm db:test:setup`, never against the dev DATABASE_URL from .env.
process.env.NODE_ENV = 'test';
// Derived from DATABASE_URL by swapping the database name, so overriding
// DB_PORT in .env flows through to the e2e suite without a second edit.
const devUrl =
  process.env.DATABASE_URL ?? 'postgresql://triage:triage@localhost:5433/triage?schema=public';
process.env.DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? devUrl.replace(/\/triage(\?|$)/, '/triage_test$1');
process.env.FAKE_LLM = process.env.FAKE_LLM ?? 'true';

// The suite asserts on HTTP responses and database rows, not on log output, and
// a full pino stream per request buries a real failure. Set E2E_LOG_LEVEL to
// debug a specific test.
process.env.LOG_LEVEL = process.env.E2E_LOG_LEVEL ?? 'fatal';
