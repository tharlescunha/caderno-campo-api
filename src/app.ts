import Fastify, { type FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';
import { agendaRoutes } from './http/agenda.js';
import { audioRoutes } from './http/audios.js';
import { authRoutes } from './http/auth.js';
import { registerErrors } from './http/errors.js';
import { exportRoutes } from './http/exports.js';
import { deviceRoutes } from './http/devices.js';
import { entryRoutes } from './http/entries.js';
import { eventRoutes } from './http/events.js';
import { healthRoutes } from './http/health.js';
import { marketRoutes } from './http/market.js';
import { notificationRoutes } from './http/notifications.js';
import { noteRoutes } from './http/notes.js';
import { DOCS_PREFIX, openApiRoutes } from './http/openapi.js';
import { periodRoutes } from './http/periods.js';
import { photoRoutes } from './http/photos.js';
import { reportRoutes } from './http/reports.js';
import { searchRoutes } from './http/search.js';
import { syncRoutes } from './http/sync.js';
import { subjectRoutes } from './http/subjects.js';
import { teacherRoutes } from './http/teachers.js';
import { todayRoutes } from './http/today.js';
import { userRoutes } from './http/users.js';

export interface AppOptions {
  log?: boolean;
  /** Where the log goes (tests read it to check nothing private is written). Default: the console. */
  logStream?: { write(chunk: string): unknown };
  /** Filled with every route that gets registered (tests check security and the docs against it). */
  routes?: RouteInfo[];
  /** Without a context only the routes that need no database (health) are registered. */
  context?: AppContext;
}

export interface RouteInfo {
  method: string;
  /** with the prefix and `:param` for parameters, e.g. `/api/v1/reports/:id/entries` */
  url: string;
}

/**
 * What the log may say about a request: method and path only. The query string is cut off (it can carry
 * exact coordinates), and headers and bodies (password, tokens) are never written.
 */
export const requestLogFields = (req: { method: string; url: string; hostname?: string; ip?: string }) => ({
  method: req.method,
  url: req.url.split('?')[0],
  host: req.hostname,
  remoteAddress: req.ip,
});

export function createApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger:
      options.log === false
        ? false
        : {
            level: 'info',
            redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body'],
            serializers: { req: requestLogFields },
            ...(options.logStream ? { stream: options.logStream } : {}),
          },
  });
  if (options.routes) {
    const routes = options.routes;
    app.addHook('onRoute', (route) => {
      // the files of the docs page (HTML, scripts, CSS) are not routes of the API
      if (route.url.startsWith(`/api/v1${DOCS_PREFIX}`)) return;
      for (const method of [route.method].flat()) if (method !== 'HEAD' && method !== 'OPTIONS') routes.push({ method, url: route.url });
    });
  }
  registerErrors(app);
  app.register(healthRoutes, { prefix: '/api/v1' });
  app.register(openApiRoutes, { prefix: '/api/v1' });
  if (options.context) {
    app.register(authRoutes(options.context), { prefix: '/api/v1' });
    app.register(userRoutes(options.context), { prefix: '/api/v1' });
    app.register(deviceRoutes(options.context), { prefix: '/api/v1' });
    app.register(periodRoutes(options.context), { prefix: '/api/v1' });
    app.register(teacherRoutes(options.context), { prefix: '/api/v1' });
    app.register(subjectRoutes(options.context), { prefix: '/api/v1' });
    app.register(eventRoutes(options.context), { prefix: '/api/v1' });
    app.register(agendaRoutes(options.context), { prefix: '/api/v1' });
    app.register(reportRoutes(options.context), { prefix: '/api/v1' });
    app.register(entryRoutes(options.context), { prefix: '/api/v1' });
    app.register(photoRoutes(options.context), { prefix: '/api/v1' });
    app.register(audioRoutes(options.context), { prefix: '/api/v1' });
    app.register(noteRoutes(options.context), { prefix: '/api/v1' });
    app.register(notificationRoutes(options.context), { prefix: '/api/v1' });
    app.register(searchRoutes(options.context), { prefix: '/api/v1' });
    app.register(todayRoutes(options.context), { prefix: '/api/v1' });
    app.register(exportRoutes(options.context), { prefix: '/api/v1' });
    app.register(syncRoutes(options.context, app), { prefix: '/api/v1' });
    if (options.context.market) app.register(marketRoutes(options.context, options.context.market), { prefix: '/api/v1' });
  }
  return app;
}
