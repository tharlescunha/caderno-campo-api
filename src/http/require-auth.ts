import type { preHandlerAsyncHookHandler } from 'fastify';
import { readAccessToken } from '../auth/crypto.js';
import type { AppContext } from '../context.js';
import { ApiError } from './errors.js';

/** Bearer-token authentication. Use as `preHandler`; sets `req.userId`. */
export function requireAuth(ctx: AppContext): preHandlerAsyncHookHandler {
  return async (req) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const userId = token ? await readAccessToken(token, ctx.config.jwtSecret) : null;
    if (!userId) throw new ApiError(401, 'unauthenticated', 'Sign in again to continue.');
    req.userId = userId;
  };
}
