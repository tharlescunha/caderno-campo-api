import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Device } from '../src/openapi/entities.js';
import { createTestApp, createTestDatabase, registerUser, type TestDatabase, type TestUser } from './helpers.js';

let t: TestDatabase;
let app: FastifyInstance;
let me: TestUser;
let other: TestUser;

const call = (user: TestUser | null, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: user ? user.headers : {},
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

beforeAll(async () => {
  t = await createTestDatabase();
  app = createTestApp(t.pool);
  me = await registerUser(app, 'me@example.test');
  other = await registerUser(app, 'other@example.test');
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

describe('devices (push registration)', () => {
  let id: string;
  const token = 'ExponentPushToken[abc123]';

  it('registers a phone: 201 with the data (never the token)', async () => {
    const r = await call(me, 'POST', '/devices', { push_token: token, platform: 'ios', name: 'iPhone 13' });
    expect(r.statusCode).toBe(201);
    id = r.json().id;
    expect(Device.safeParse(r.json()).success).toBe(true);
    expect(r.json()).toMatchObject({ name: 'iPhone 13', platform: 'ios', active: true });
    expect(r.json().last_seen_at).toMatch(/Z$/);
    expect(r.body).not.toContain(token);
  });

  it('the same token again refreshes the same record (200); a missing name keeps the old one', async () => {
    const again = await call(me, 'POST', '/devices', { push_token: token, platform: 'ios' });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(id);
    expect(again.json().name).toBe('iPhone 13');
    const renamed = await call(me, 'POST', '/devices', { push_token: token, platform: 'ios', name: 'My phone' });
    expect(renamed.json()).toMatchObject({ id, name: 'My phone' });
    expect((await t.pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM dispositivo WHERE usuario_id = ?', [me.id]))[0][0]!.n).toBe(1);
  });

  it('a new token is a new device, and the phone can choose the id', async () => {
    const chosen = randomUUID();
    const r = await call(me, 'POST', '/devices', { id: chosen, push_token: 'ExponentPushToken[second]', platform: 'android' });
    expect(r.statusCode).toBe(201);
    expect(r.json().id).toBe(chosen);
    expect(r.json().name).toBeNull();
  });

  it('validation: token and platform are required', async () => {
    const r = await call(me, 'POST', '/devices', { push_token: '', platform: 'symbian' });
    expect(r.statusCode).toBe(422);
    expect(
      r
        .json()
        .error.fields.map((f: { field: string }) => f.field)
        .sort(),
    ).toEqual(['platform', 'push_token']);
    expect((await call(me, 'POST', '/devices', { platform: 'ios' })).statusCode).toBe(422);
    expect((await call(me, 'POST', '/devices', { push_token: 'x'.repeat(256), platform: 'ios' })).statusCode).toBe(422);
  });

  it('a phone that changes hands: the same token on another account moves there, so it never gets two accounts’ reminders', async () => {
    const moved = await call(other, 'POST', '/devices', { push_token: token, platform: 'ios', name: 'Same phone, new owner' });
    expect(moved.statusCode).toBe(201);
    expect((await t.pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM dispositivo WHERE token_push = ?', [token]))[0][0]!.n).toBe(1);
    expect(
      (await t.pool.query<RowDataPacket[]>('SELECT usuario_id FROM dispositivo WHERE token_push = ?', [token]))[0][0]!.usuario_id,
    ).toBe(other.id);
    // mine is gone: deleting it is a 404 now
    expect((await call(me, 'DELETE', `/devices/${id}`)).statusCode).toBe(404);
  });

  it('delete removes the device (204); the other account cannot remove mine', async () => {
    const mine = (await call(me, 'POST', '/devices', { push_token: 'ExponentPushToken[mine]', platform: 'android' })).json().id;
    expect((await call(other, 'DELETE', `/devices/${mine}`)).statusCode).toBe(404);
    expect((await t.pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM dispositivo WHERE id = ?', [mine]))[0][0]!.n).toBe(1);
    expect((await call(me, 'DELETE', `/devices/${mine}`)).statusCode).toBe(204);
    expect((await call(me, 'DELETE', `/devices/${mine}`)).statusCode).toBe(404);
    expect((await call(me, 'DELETE', '/devices/not-a-uuid')).statusCode).toBe(422);
  });

  it('needs a token', async () => {
    expect((await call(null, 'POST', '/devices', { push_token: 'x', platform: 'ios' })).statusCode).toBe(401);
    expect((await call(null, 'DELETE', `/devices/${randomUUID()}`)).statusCode).toBe(401);
  });

  it('the account export lists devices without the push token, and deleting the account removes them', async () => {
    const user = await registerUser(app, 'leaving@example.test');
    await call(user, 'POST', '/devices', { push_token: 'ExponentPushToken[leaving]', platform: 'web', name: 'Browser' });
    const dump = (await call(user, 'GET', '/users/me/export')).json();
    expect(dump.data.dispositivo).toHaveLength(1);
    expect(dump.data.dispositivo[0].nome).toBe('Browser');
    expect(JSON.stringify(dump)).not.toContain('ExponentPushToken');
    expect((await call(user, 'DELETE', '/users/me', { password: 'correct horse' })).statusCode).toBe(204);
    expect((await t.pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM dispositivo WHERE usuario_id = ?', [user.id]))[0][0]!.n).toBe(0);
  });
});
