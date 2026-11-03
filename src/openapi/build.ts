import { z, type ZodType } from 'zod';
import { VERSION } from '../version.js';
import * as E from './entities.js';
import { endpoints, type Endpoint, type ResponseSpec } from './registry.js';

type Json = Record<string, unknown>;

const DESCRIPTION = [
  'API of Caderno de Campo. Names of routes, fields and error codes are in English.',
  'Every route needs `Authorization: Bearer <access_token>` except the ones marked public.',
  'Errors always have the shape `{ "error": { "code", "message", "fields?", "details?" } }`.',
  'The rules behind each route (what changes, what is kept, limits) are in docs/api.md of the documentation repository.',
].join('\n\n');

/** Zod's JSON Schema, without the regular expressions it adds for formats (they only make the document heavy). */
function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (node && typeof node === 'object') {
    const out: Json = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === '$schema') continue;
      if (key === 'pattern' && 'format' in node) continue;
      out[key] = clean(value);
    }
    return out;
  }
  return node;
}

const components: Record<string, unknown> = {};

/** JSON Schema of a Zod schema; the named ones (see entities.ts) go to `components.schemas` and are referenced. */
function schemaOf(schema: ZodType, io: 'input' | 'output'): Json {
  const raw = z.toJSONSchema(schema, { target: 'draft-2020-12', io, unrepresentable: 'any' }) as Json & { $defs?: Record<string, unknown> };
  const { $defs, ...rest } = raw;
  for (const [name, def] of Object.entries($defs ?? {})) components[name] = clean(def);
  const text = JSON.stringify(clean(rest)).replaceAll('#/$defs/', '#/components/schemas/');
  return JSON.parse(text) as Json;
}

/** The name a schema has in the document, if it is one of the named entities. */
function nameOf(schema: ZodType): string | null {
  const meta = z.globalRegistry.get(schema) as { id?: string } | undefined;
  return meta?.id ?? null;
}

function bodyOrRef(schema: ZodType, io: 'input' | 'output'): Json {
  const name = nameOf(schema);
  if (name) {
    const built = schemaOf(schema, io);
    // a named schema comes out as { $ref } + its definition in components
    return built.$ref ? built : { $ref: `#/components/schemas/${name}` };
  }
  return schemaOf(schema, io);
}

function response(spec: ResponseSpec, status: number): Json {
  if (typeof spec === 'string') {
    if (spec === 'No content') return { description: 'No content' };
    return {
      description: spec,
      content: spec.startsWith('JSON')
        ? { 'application/json': { schema: { type: 'object' } } }
        : { '*/*': { schema: { type: 'string', format: 'binary' } } },
    };
  }
  const description = status >= 400 ? 'Error' : 'Success';
  return { description, content: { 'application/json': { schema: bodyOrRef(spec, 'output') } } };
}

function parameters(endpoint: Endpoint): Json[] {
  const list: Json[] = [];
  for (const name of endpoint.path.match(/:(\w+)/g) ?? []) {
    const numeric = endpoint.path.startsWith('/market/news');
    list.push({
      name: name.slice(1),
      in: 'path',
      required: true,
      schema: numeric ? { type: 'string', pattern: '^\\d+$' } : { type: 'string', format: 'uuid' },
    });
  }
  if (endpoint.query) {
    const built = schemaOf(endpoint.query, 'input') as { properties?: Record<string, Json>; required?: string[] };
    for (const [name, schema] of Object.entries(built.properties ?? {})) {
      list.push({ name, in: 'query', required: built.required?.includes(name) ?? false, schema });
    }
  }
  return list;
}

function requestBody(endpoint: Endpoint): Json | undefined {
  if (endpoint.body) return { required: true, content: { 'application/json': { schema: bodyOrRef(endpoint.body, 'input') } } };
  if (endpoint.multipart) {
    const fields = endpoint.multipart === true ? {} : ((schemaOf(endpoint.multipart, 'input') as { properties?: Json }).properties ?? {});
    return {
      required: true,
      content: {
        'multipart/form-data': {
          schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, ...fields }, required: ['file'] },
        },
      },
    };
  }
  return undefined;
}

/** `/reports/:id/entries` -> `/reports/{id}/entries` */
export const openApiPath = (path: string) => path.replace(/:(\w+)/g, '{$1}');

export function buildOpenApi(): Json {
  for (const key of Object.keys(components)) delete components[key];
  const paths: Record<string, Record<string, unknown>> = {};
  for (const endpoint of endpoints) {
    const responses: Record<number, ResponseSpec> = { ...endpoint.responses };
    if (endpoint.auth !== false && !responses[401]) responses[401] = E.ErrorBody;
    const operation: Json = {
      tags: [endpoint.tag],
      summary: endpoint.summary,
      operationId: `${endpoint.method.toLowerCase()}${endpoint.path.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ''))}`,
      ...(endpoint.auth === false ? { security: [] } : {}),
      parameters: parameters(endpoint),
      ...(requestBody(endpoint) ? { requestBody: requestBody(endpoint) } : {}),
      responses: Object.fromEntries(Object.entries(responses).map(([status, spec]) => [status, response(spec, Number(status))])),
    };
    (paths[openApiPath(endpoint.path)] ??= {})[endpoint.method.toLowerCase()] = operation;
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Caderno de Campo API', version: VERSION, description: DESCRIPTION },
    servers: [{ url: '/api/v1' }],
    security: [{ bearerAuth: [] }],
    tags: [...new Set(endpoints.map((e) => e.tag))].map((name) => ({ name })),
    paths,
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } }, schemas: components },
  };
}

/** The document as JSON text, with the references between named schemas pointing to `components`. */
export function openApiJson(): Json {
  const document = buildOpenApi();
  return JSON.parse(JSON.stringify(document).replaceAll('#/$defs/', '#/components/schemas/')) as Json;
}
