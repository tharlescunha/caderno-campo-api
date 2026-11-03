import { readFileSync } from 'node:fs';
import { z } from 'zod';

// Secrets can come directly (DB_PASSWORD) or from a file (DB_PASSWORD_FILE, the Docker secrets way).
function secret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim();
  return env[name] || undefined;
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(3306),
  DB_NAME: z.string().default('caderno'),
  DB_USER: z.string().default('caderno'),
  MIGRATIONS_DIR: z.string().default('migrations'),
  MEDIA_DIR: z.string().default('data/media'),
  // Without it audios are stored but not transcribed until it is set
  TRANSCRIPTION_URL: z.string().url().optional(),
  // Weather for places without a saved location (default: Palmas-TO)
  WEATHER_DEFAULT_LAT: z.coerce.number().min(-90).max(90).default(-10.1927),
  WEATHER_DEFAULT_LON: z.coerce.number().min(-180).max(180).default(-48.3132),
  MARKET_REFRESH_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  MARKET_TIMEZONE: z.string().default('America/Araguaina'),
  MARKET_ENABLED: z.enum(['true', 'false']).default('true'),
  // After the first user exists, sign-up is closed unless this is "true" (docs/api.md, section 3)
  ALLOW_SIGNUP: z.enum(['true', 'false']).default('false'),
});

export interface Config {
  environment: 'development' | 'production' | 'test';
  host: string;
  port: number;
  db: { host: string; port: number; name: string; user: string; password: string };
  jwtSecret: string;
  allowSignup: boolean;
  migrationsDir: string;
  mediaDir: string;
  transcriptionUrl?: string;
  openWeatherKey?: string;
  weatherDefault: { latitude: number; longitude: number };
  market: { enabled: boolean; refreshMinutes: number; timezone: string };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = schema.parse(env);
  const password = secret(env, 'DB_PASSWORD');
  if (!password) throw new Error('Set DB_PASSWORD_FILE (or DB_PASSWORD): database password.');
  const openWeatherKey = secret(env, 'OPENWEATHER_API_KEY') || undefined;
  const jwtSecret = secret(env, 'JWT_SECRET');
  if (!jwtSecret || jwtSecret.length < 32) throw new Error('Set JWT_SECRET_FILE (or JWT_SECRET) with at least 32 characters.');
  return {
    environment: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    db: { host: e.DB_HOST, port: e.DB_PORT, name: e.DB_NAME, user: e.DB_USER, password },
    jwtSecret,
    allowSignup: e.ALLOW_SIGNUP === 'true',
    migrationsDir: e.MIGRATIONS_DIR,
    mediaDir: e.MEDIA_DIR,
    ...(e.TRANSCRIPTION_URL ? { transcriptionUrl: e.TRANSCRIPTION_URL } : {}),
    ...(openWeatherKey ? { openWeatherKey } : {}),
    weatherDefault: { latitude: e.WEATHER_DEFAULT_LAT, longitude: e.WEATHER_DEFAULT_LON },
    market: { enabled: e.MARKET_ENABLED === 'true', refreshMinutes: e.MARKET_REFRESH_MINUTES, timezone: e.MARKET_TIMEZONE },
  };
}
