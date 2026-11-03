import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { search } from '../search/index.js';
import { validate } from './errors.js';
import { requireAuth } from './require-auth.js';

export const query = z.object({ q: z.string().trim().min(2, 'Type at least 2 letters.').max(100) });

export const searchRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    app.addHook('preHandler', requireAuth(ctx));

    // One search in notes, reports, entries, subjects and events of the user: at most 5 of each.
    app.get('/search', async (req) => search(ctx.pool, req.userId, validate(query, req.query).q));
  };
