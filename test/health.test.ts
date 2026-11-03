import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const app = createApp({ log: false });
afterAll(() => app.close());

describe('GET /api/v1/health', () => {
  it('returns status, version and server time in UTC', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.status).toBe('ok');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.server_time).toMatch(/Z$/);
    expect(Math.abs(Date.now() - Date.parse(body.server_time))).toBeLessThan(5000);
  });
});
