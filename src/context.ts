import type { Pool } from 'mysql2/promise';
import type { AttemptLimiter } from './auth/rate-limit.js';
import type { Config } from './config.js';
import type { MarketService } from './market/service.js';
import type { MediaStorage } from './media/storage.js';

// What the routes need to work; built once in server.ts (or by the tests).
export interface AppContext {
  config: Pick<Config, 'jwtSecret' | 'allowSignup'>;
  pool: Pool;
  loginLimiter: AttemptLimiter;
  media: MediaStorage;
  /** Market and weather providers. Without it, those routes are not registered and entries with coordinates stay "pending". */
  market?: MarketService;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireAuth`: the id of the logged-in user. Every query must filter by it. */
    userId: string;
  }
}
