import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError, type ZodType } from 'zod';

// Single error format (docs/api.md, section 1)
export interface InvalidField {
  field: string;
  message: string;
}

export interface ErrorBody {
  error: { code: string; message: string; fields?: InvalidField[]; details?: unknown };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: InvalidField[],
    /** Extra data for the client, e.g. the closing preview of a period. */
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function zodFields(e: ZodError): InvalidField[] {
  return e.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
}

/** Validates with Zod; on failure throws 422 `validation` with the list of fields. */
export function validate<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new ApiError(422, 'validation', 'Some fields are invalid.', zodFields(r.error));
  return r.data;
}

const KNOWN: Record<number, [string, string]> = {
  401: ['unauthenticated', 'Sign in again to continue.'],
  404: ['not_found', 'Not found.'],
  409: ['conflict', 'Conflicts with the current state.'],
  413: ['payload_too_large', 'The content sent is too large.'],
  415: ['unsupported_media_type', 'Unsupported content type.'],
  429: ['too_many_attempts', 'Too many attempts. Wait a moment.'],
};

function body(code: string, message: string, fields?: InvalidField[], details?: unknown): ErrorBody {
  return { error: { code, message, ...(fields ? { fields } : {}), ...(details !== undefined ? { details } : {}) } };
}

/**
 * What goes to the log for an unexpected error. MySQL errors carry the whole SQL text, with the values
 * (password hash, e-mail, coordinates), so only the harmless parts are kept.
 */
export function loggable(err: unknown) {
  const e = err as { name?: string; code?: string; errno?: number; sqlState?: string; message?: string; stack?: string };
  // the first line of the stack repeats the message; the frames after it say where it happened
  const frames = e.stack?.split(String.fromCharCode(10)).slice(1, 8).join(String.fromCharCode(10));
  return {
    name: e.name,
    code: e.code,
    errno: e.errno,
    sqlState: e.sqlState,
    // the message of a database error can quote values (Duplicate entry 'x' ...): keep the start, without quoted text
    message: (e.message ?? '').slice(0, 80).replace(/'[^']*'/g, "'...'"),
    stack: frames,
  };
}

export function registerErrors(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | ApiError | ZodError, req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send(body(err.code, err.message, err.fields, err.details));
    if (err instanceof ZodError) return reply.status(422).send(body('validation', 'Some fields are invalid.', zodFields(err)));

    if ((err as { code?: string }).code === 'ER_DUP_ENTRY')
      return reply.status(409).send(body('conflict', 'Conflicts with the current state.'));
    const status = 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status === 400) return reply.status(400).send(body('invalid_json', 'The request body is not valid JSON.'));
    const known = KNOWN[status];
    if (status < 500 && known) return reply.status(status).send(body(known[0], known[1]));
    // any other 4xx raised by the framework (for example a request that is not multipart where a file is expected)
    if (status >= 400 && status < 500) return reply.status(status).send(body('bad_request', 'The request is not valid.'));

    req.log.error({ err: loggable(err) }, 'internal error');
    return reply.status(500).send(body('internal_error', 'Something went wrong. Try again shortly.'));
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send(body('not_found', 'Route not found.'));
  });
}
