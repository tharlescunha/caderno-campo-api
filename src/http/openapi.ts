import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyPluginAsync } from 'fastify';
import { openApiJson } from '../openapi/build.js';

/** Where the docs page lives (under /api/v1). Its files are not part of the API's route list. */
export const DOCS_PREFIX = '/docs';

// Public on purpose: the phone and the site read it to generate their types, and the page below shows it.
// They describe the shape of the API, not data. "Authorize" on the page takes an access token to try the routes.
export const openApiRoutes: FastifyPluginAsync = async (app) => {
  const document = openApiJson();
  app.get('/openapi.json', async () => document);

  await app.register(swagger, { mode: 'static', specification: { document: document as never } });
  await app.register(swaggerUi, {
    routePrefix: DOCS_PREFIX,
    uiConfig: { docExpansion: 'list', deepLinking: true, persistAuthorization: false, tryItOutEnabled: false },
  });
};
