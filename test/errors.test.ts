import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import { ApiError, validate } from '../src/http/errors.js';

const app = createApp({ log: false });
const bodySchema = z.object({ title: z.string().min(1, 'Enter the title.') });

app.post('/test/validate', async (req) => validate(bodySchema, req.body));
app.get('/test/conflict', async () => {
  throw new ApiError(409, 'conflict', 'E-mail already registered.');
});
app.get('/test/crash', async () => {
  throw new Error('internal detail that must not leak');
});

afterAll(() => app.close());

describe('standard error format (api.md, section 1)', () => {
  it('422 validation with the list of fields', async () => {
    const r = await app.inject({ method: 'POST', url: '/test/validate', payload: { title: '' } });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toEqual({
      error: { code: 'validation', message: 'Some fields are invalid.', fields: [{ field: 'title', message: 'Enter the title.' }] },
    });
  });

  it('400 for invalid JSON', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/test/validate',
      headers: { 'content-type': 'application/json' },
      payload: '{ broken',
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('invalid_json');
  });

  it('404 for a route that does not exist', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/nothing' });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('not_found');
  });

  it('ApiError becomes the chosen status and code', async () => {
    const r = await app.inject({ method: 'GET', url: '/test/conflict' });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: { code: 'conflict', message: 'E-mail already registered.' } });
  });

  it('500 does not leak internal details', async () => {
    const r = await app.inject({ method: 'GET', url: '/test/crash' });
    expect(r.statusCode).toBe(500);
    expect(r.json().error.code).toBe('internal_error');
    expect(r.body).not.toContain('internal detail');
  });
});
