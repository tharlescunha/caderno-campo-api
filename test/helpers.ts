import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MarketService } from '../src/market/service.js';
import { MediaStorage } from '../src/media/storage.js';
import { AttemptLimiter } from '../src/auth/rate-limit.js';
import { createApp, type AppOptions } from '../src/app.js';
import { createPool } from '../src/db/connection.js';
import { applyMigrations } from '../src/db/migrate.js';

// Needs the test MySQL (from docker/):  docker compose --profile test up -d --wait db-test
export const testConnection = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 3308),
  user: process.env.TEST_DB_USER ?? 'root',
  password: process.env.TEST_DB_PASSWORD,
};
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export const TEST_JWT_SECRET = randomBytes(32).toString('hex');

export interface TestDatabase {
  admin: Pool;
  pool: Pool;
  name: string;
  drop: () => Promise<void>;
}

export async function createTestDatabase(migrate = true): Promise<TestDatabase> {
  const admin = createPool(testConnection);
  const name = `caderno_test_${randomBytes(4).toString('hex')}`;
  await admin.query(`CREATE DATABASE \`${name}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  const pool = createPool({ ...testConnection, database: name });
  if (migrate) await applyMigrations(pool, MIGRATIONS_DIR);
  return {
    admin,
    pool,
    name,
    drop: async () => {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
      await admin.end();
    },
  };
}

export function createTestApp(
  pool: Pool,
  allowSignup = true,
  mediaDir = mkdtempSync(join(tmpdir(), 'caderno-media-')),
  market?: MarketService,
  extra: Partial<AppOptions> = {},
): FastifyInstance {
  return createApp({
    log: false,
    ...extra,
    context: {
      config: { jwtSecret: TEST_JWT_SECRET, allowSignup },
      pool,
      loginLimiter: new AttemptLimiter(),
      media: new MediaStorage(mediaDir),
      ...(market ? { market } : {}),
    },
  });
}

export interface TestUser {
  id: string;
  headers: { authorization: string };
}

/** Registers a user (sign-up is open in the test app) and returns its id and auth header. */
export async function registerUser(app: FastifyInstance, email: string): Promise<TestUser> {
  const r = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { name: 'Test User', email, password: 'correct horse', accepted_terms: true },
  });
  if (r.statusCode !== 201) throw new Error(`register failed: ${r.body}`);
  const body = r.json();
  return { id: body.user.id, headers: { authorization: `Bearer ${body.access_token}` } };
}
