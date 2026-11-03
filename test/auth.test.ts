import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestDatabase, type TestDatabase } from './helpers.js';

let t: TestDatabase;
let app: FastifyInstance;

beforeAll(async () => {
  t = await createTestDatabase();
  app = createTestApp(t.pool);
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

const validBody = (email: string) => ({
  name: 'Tharles Cunha',
  email,
  password: 'correct horse',
  course: 'Agronomia',
  institution: 'Faculdade',
  accepted_terms: true,
});

async function register(email: string) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: validBody(email) });
  expect(r.statusCode).toBe(201);
  return r.json() as { user: { id: string }; access_token: string; refresh_token: string };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('POST /auth/register', () => {
  it('creates the account, hashes the password with Argon2id and returns tokens', async () => {
    const body = await register('a@example.test');
    expect(body.user).toMatchObject({ name: 'Tharles Cunha', email: 'a@example.test', course: 'Agronomia', theme: 'system' });
    expect(JSON.stringify(body)).not.toContain('senha');
    const [rows] = await t.pool.query<RowDataPacket[]>('SELECT senha_hash FROM usuario WHERE id = ?', [body.user.id]);
    expect(rows[0]?.senha_hash).toMatch(/^\$argon2id\$/);
  });

  it('409 for a repeated e-mail (any letter case)', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: validBody('A@Example.test') });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('email_in_use');
  });

  it('422 for short password, bad e-mail and terms not accepted', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { ...validBody('x'), password: '123', accepted_terms: false },
    });
    expect(r.statusCode).toBe(422);
    expect(
      r
        .json()
        .error.fields.map((f: { field: string }) => f.field)
        .sort(),
    ).toEqual(['accepted_terms', 'email', 'password']);
  });

  it('403 when sign-up is closed and a user already exists', async () => {
    const closed = createTestApp(t.pool, false);
    const r = await closed.inject({ method: 'POST', url: '/api/v1/auth/register', payload: validBody('b@example.test') });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('signup_closed');
    await closed.close();
  });
});

describe('POST /auth/login', () => {
  it('logs in and returns the user with a working access token', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'A@example.test', password: 'correct horse' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.expires_in).toBe(900);
    const me = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: bearer(body.access_token) });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe('a@example.test');
  });

  it('401 with the same message for wrong password and unknown e-mail', async () => {
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'a@example.test', password: 'nope nope' },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'who@example.test', password: 'nope nope' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it('keep_logged_in sets a 30-day refresh token, otherwise 1 day', async () => {
    const login = (keep: boolean) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'a@example.test', password: 'correct horse', keep_logged_in: keep },
      });
    const days = async (refresh: string) => {
      const { sha256 } = await import('../src/auth/crypto.js');
      const [rows] = await t.pool.query<RowDataPacket[]>(
        'SELECT TIMESTAMPDIFF(HOUR, criado_em, expira_em) AS h FROM refresh_token WHERE token_hash = ?',
        [sha256(refresh)],
      );
      return Math.round((rows[0]?.h as number) / 24);
    };
    expect(await days((await login(true)).json().refresh_token)).toBe(30);
    expect(await days((await login(false)).json().refresh_token)).toBe(1);
  });

  it('429 after 10 failed attempts', async () => {
    const limited = createTestApp(t.pool);
    const attempt = () =>
      limited.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'a@example.test', password: 'wrong wrong' } });
    for (let i = 0; i < 10; i++) expect((await attempt()).statusCode).toBe(401);
    const blocked = await attempt();
    expect(blocked.statusCode).toBe(429);
    // even the right password is refused while blocked
    const right = await limited.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'a@example.test', password: 'correct horse' },
    });
    expect(right.statusCode).toBe(429);
    await limited.close();
  });
});

describe('refresh and logout', () => {
  it('refresh rotates: the old token stops working', async () => {
    const { refresh_token } = await register('c@example.test');
    const first = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refresh_token } });
    expect(first.statusCode).toBe(200);
    expect(first.json().refresh_token).not.toBe(refresh_token);
    const reuse = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refresh_token } });
    expect(reuse.statusCode).toBe(401);
    const next = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refresh_token: first.json().refresh_token } });
    expect(next.statusCode).toBe(200);
  });

  it('logout revokes the refresh token', async () => {
    const { refresh_token } = await register('d@example.test');
    const out = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', payload: { refresh_token } });
    expect(out.statusCode).toBe(204);
    const after = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refresh_token } });
    expect(after.statusCode).toBe(401);
  });

  it('DELETE /users/me/sessions signs out of every device', async () => {
    const a = await register('sessions@example.test');
    const b = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'sessions@example.test', password: 'correct horse' } });
    expect(b.statusCode).toBe(200);
    const out = await app.inject({ method: 'DELETE', url: '/api/v1/users/me/sessions', headers: bearer(a.access_token) });
    expect(out.statusCode).toBe(204);
    for (const token of [a.refresh_token, b.json().refresh_token]) {
      expect((await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refresh_token: token } })).statusCode).toBe(401);
    }
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/users/me/sessions' })).statusCode).toBe(401);
  });

  it('an unknown refresh token is 401', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refresh_token: 'nope' } });
    expect(r.statusCode).toBe(401);
  });
});

describe('authentication middleware and /users/me', () => {
  it('401 without token, with garbage and with a token signed by another secret', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/users/me' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: bearer('garbage') })).statusCode).toBe(401);
    const { signAccessToken } = await import('../src/auth/crypto.js');
    const forged = await signAccessToken('any-id', 'another secret another secret 123456');
    expect((await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: bearer(forged) })).statusCode).toBe(401);
  });

  it('PATCH updates only what was sent and bumps the version', async () => {
    const { access_token } = await register('e@example.test');
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: bearer(access_token),
      payload: {
        theme: 'dark',
        default_location: { latitude: -10.25, longitude: -48.32 },
        first_access_completed: true,
        remind_record_time: '19:30',
      },
    });
    expect(r.statusCode).toBe(200);
    const u = r.json();
    expect(u).toMatchObject({
      theme: 'dark',
      name: 'Tharles Cunha',
      remind_record_time: '19:30',
      default_location: { latitude: -10.25, longitude: -48.32 },
    });
    expect(u.first_access_completed_at).toMatch(/Z$/);
    expect(u.version).toBeGreaterThan(1);
  });

  it('PATCH rejects unknown fields and bad values', async () => {
    const { access_token } = await register('f@example.test');
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: bearer(access_token),
      payload: { email: 'x@y.z', theme: 'pink' },
    });
    expect(r.statusCode).toBe(422);
  });

  it('changes the password, revokes sessions and the new password works', async () => {
    const { access_token, refresh_token } = await register('g@example.test');
    const bad = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me/password',
      headers: bearer(access_token),
      payload: { current_password: 'wrong wrong', new_password: 'brand new pass' },
    });
    expect(bad.statusCode).toBe(422);
    const ok = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me/password',
      headers: bearer(access_token),
      payload: { current_password: 'correct horse', new_password: 'brand new pass' },
    });
    expect(ok.statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refresh_token } })).statusCode).toBe(401);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'g@example.test', password: 'brand new pass' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('PATCH /users/me changes the three notice switches', async () => {
    const u = await register('notices@example.test');
    const off = await app.inject({ method: 'PATCH', url: '/api/v1/users/me', headers: bearer(u.access_token), payload: { notify_exams_and_deadlines: false, notify_field_class_eve: false, notify_report_deadline: false } });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ notify_exams_and_deadlines: false, notify_field_class_eve: false, notify_report_deadline: false });
    const on = await app.inject({ method: 'PATCH', url: '/api/v1/users/me', headers: bearer(u.access_token), payload: { notify_field_class_eve: true } });
    expect(on.json()).toMatchObject({ notify_exams_and_deadlines: false, notify_field_class_eve: true });
  });

  it('isolation: each token only sees its own account', async () => {
    const one = await register('h1@example.test');
    const two = await register('h2@example.test');
    const a = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: bearer(one.access_token) });
    const b = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: bearer(two.access_token) });
    expect(a.json().email).toBe('h1@example.test');
    expect(b.json().email).toBe('h2@example.test');
    // changing one account never touches the other
    await app.inject({ method: 'PATCH', url: '/api/v1/users/me', headers: bearer(one.access_token), payload: { name: 'Changed' } });
    const b2 = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: bearer(two.access_token) });
    expect(b2.json().name).toBe('Tharles Cunha');
  });
});
