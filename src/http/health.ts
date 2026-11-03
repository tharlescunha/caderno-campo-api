import type { FastifyPluginAsync } from 'fastify';
import { VERSION } from '../version.js';

// Public (no login): used by the Docker healthcheck and to confirm the server is up.
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => ({
    status: 'ok',
    version: VERSION,
    server_time: new Date().toISOString(),
  }));
};
