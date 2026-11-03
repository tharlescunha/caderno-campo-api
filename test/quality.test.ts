import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RouteInfo } from '../src/app.js';
import { TranscriptionWorker } from '../src/audios/worker.js';
import { MarketService } from '../src/market/service.js';
import { MediaStorage } from '../src/media/storage.js';
import { openApiJson as buildOpenApi, openApiPath } from '../src/openapi/build.js';
import * as E from '../src/openapi/entities.js';
import { endpoints } from '../src/openapi/registry.js';
import { NotificationGenerator } from '../src/notifications/generator.js';
import { FakeNetwork } from './fake-network.js';
import { createTestApp, createTestDatabase, registerUser, type TestDatabase, type TestUser } from './helpers.js';

const MARK = 'ZZMARKERZZ';
let t: TestDatabase;
let app: FastifyInstance;
let mediaDir: string;
let me: TestUser;
let other: TestUser;
const routes: RouteInfo[] = [];

const ids: Record<string, string> = {};
const call = (user: TestUser | null, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: user ? user.headers : {},
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
const png = () =>
  sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 4, g: 90, b: 30 } } })
    .png()
    .toBuffer();

async function multipart(user: TestUser, url: string, data: Buffer, type: string, filename: string, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(data)], { type }), filename);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const response = new Response(form);
  return app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    headers: { ...user.headers, 'content-type': response.headers.get('content-type')! },
    payload: Buffer.from(await response.arrayBuffer()),
  });
}

beforeAll(async () => {
  t = await createTestDatabase();
  mediaDir = mkdtempSync(join(tmpdir(), 'caderno-quality-'));
  const market = new MarketService(t.pool, new FakeNetwork().fetch, {
    openWeatherKey: 'k',
    defaultLatitude: -10.19,
    defaultLongitude: -48.31,
  });
  app = createTestApp(t.pool, true, mediaDir, market, { routes });
  me = await registerUser(app, 'me@example.test');
  other = await registerUser(app, 'other@example.test');

  // one of everything, all marked, for the account `me`
  ids.period = (await call(me, 'POST', '/periods', { name: `${MARK} term`, start_date: '2026-08-03' })).json().id;
  ids.teacher = (await call(me, 'POST', '/teachers', { name: `${MARK} teacher`, email: 'prof@example.test' })).json().id;
  ids.subject = (
    await call(me, 'POST', '/subjects', { name: `${MARK} subject`, weekdays: [2], class_type: 'field', teacher_id: ids.teacher })
  ).json().id;
  ids.event = (
    await call(me, 'POST', '/events', {
      type: 'exam',
      title: `${MARK} exam`,
      subject_id: ids.subject,
      date: '2099-01-10',
      reminder: '1_day',
    })
  ).json().id;
  ids.report = (
    await call(me, 'POST', '/reports', {
      title: `${MARK} report`,
      subject_id: ids.subject,
      type: 'continuous',
      area: { crop: 'milho', length_m: 10, width_m: 5 },
      delivery_date: '2099-01-20',
      tags: [MARK],
    })
  ).json().id;
  const entry = (
    await call(me, 'POST', `/reports/${ids.report}/entries`, {
      status: 'completed',
      activities: ['inspection'],
      notes: `${MARK} entry`,
      next_visit: [`${MARK} item`],
      weather: { origin: 'manual', temperature_c: 30 },
      tags: ['x'],
    })
  ).json();
  ids.entry = entry.id;
  ids.todo = entry.todos[0].id;
  ids.photo = (
    await multipart(me, `/entries/${ids.entry}/photos`, await png(), 'image/png', 'a.png', { caption: MARK })
  ).json().items[0].id;
  await multipart(me, `/reports/${ids.report}/area-photo`, await png(), 'image/png', 'b.png');
  ids.eventPhoto = (await multipart(me, `/events/${ids.event}/photos`, await png(), 'image/png', 'c.png')).json().items[0].id;
  const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(300, 1)]);
  ids.audio = (
    await multipart(me, `/entries/${ids.entry}/audios`, ogg, 'audio/ogg', 'v.ogg', { duration_s: '8', recorded_at: '2026-11-03T11:00:00Z' })
  ).json().id;
  ids.note = (await call(me, 'POST', '/notes', { title: `${MARK} note`, text: `${MARK} text`, subject_id: ids.subject })).json().id;
  ids.attachment = (
    await multipart(me, `/notes/${ids.note}/attachments`, Buffer.from('%PDF-1.4 x'), 'application/pdf', 'd.pdf')
  ).json().items[0].id;
  await new TranscriptionWorker(t.pool, new MediaStorage(mediaDir), {
    transcribe: async () => ({ text: `${MARK} spoken`, confidence: 0.9 }),
  }).runOnce();
  await t.pool.query(
    "INSERT INTO notificacao (id, usuario_id, tipo, titulo, referencia_tipo, referencia_id, agendada_para, enviada_em) VALUES (UUID(), ?, 'lembrete_evento', ?, 'evento', ?, NOW(3), NOW(3))",
    [me.id, `${MARK} reminder`, ids.event],
  );
  ids.device = (
    await call(me, 'POST', '/devices', { push_token: `ExponentPushToken[${MARK}]`, platform: 'android', name: `${MARK} phone` })
  ).json().id;
  ids.notification = (await t.pool.query<RowDataPacket[]>('SELECT id FROM notificacao WHERE usuario_id = ?', [me.id]))[0][0]!.id;
  void NotificationGenerator;
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

describe('the list of routes (registry) and the OpenAPI document', () => {
  const keyOf = (method: string, path: string) => `${method} ${path}`;

  it('the registry has exactly the routes that exist: a new route cannot be forgotten', () => {
    const real = routes.map((r) => keyOf(r.method, r.url.replace('/api/v1', ''))).sort();
    const listed = endpoints.map((e) => keyOf(e.method, e.path)).sort();
    expect(real).toEqual(listed);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('GET /openapi.json is public and describes every route', async () => {
    const r = await call(null, 'GET', '/openapi.json');
    expect(r.statusCode).toBe(200);
    const doc = r.json();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('Caderno de Campo API');
    expect(doc.servers).toEqual([{ url: '/api/v1' }]);
    for (const e of endpoints) expect(doc.paths[openApiPath(e.path)]?.[e.method.toLowerCase()], keyOf(e.method, e.path)).toBeTruthy();
    expect(Object.values<Record<string, unknown>>(doc.paths).flatMap((p) => Object.keys(p)).length).toBe(endpoints.length);
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
  });

  it('the docs page (Swagger UI) is public, shows this same document, and its files are not counted as API routes', async () => {
    const page = await call(null, 'GET', '/docs/');
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('swagger-ui');
    const json = await call(null, 'GET', '/docs/json');
    expect(json.statusCode).toBe(200);
    expect(json.json().info.title).toBe('Caderno de Campo API');
    expect(Object.keys(json.json().paths).length).toBe(Object.keys((await call(null, 'GET', '/openapi.json')).json().paths).length);
    expect(routes.some((r) => r.url.includes('/docs'))).toBe(false);
    // the page loads its own scripts: nothing comes from another site
    const asset = await call(null, 'GET', '/docs/static/swagger-ui-bundle.js');
    expect(asset.statusCode).toBe(200);
  });

  it('public routes say so; the others need the bearer token', () => {
    const doc = buildOpenApi() as { security: unknown[]; paths: Record<string, Record<string, { security?: unknown[] }>> };
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
    const publicOnes = endpoints
      .filter((e) => e.auth === false)
      .map((e) => keyOf(e.method, e.path))
      .sort();
    expect(publicOnes).toEqual([
      'GET /health',
      'GET /openapi.json',
      'POST /auth/login',
      'POST /auth/logout',
      'POST /auth/refresh',
      'POST /auth/register',
    ]);
    for (const e of endpoints) {
      const op = doc.paths[openApiPath(e.path)]![e.method.toLowerCase()]!;
      expect(op.security !== undefined, keyOf(e.method, e.path)).toBe(e.auth === false);
    }
  });

  it('every $ref points to a schema that exists, operation ids are unique, bodies and params are described', () => {
    const doc = buildOpenApi() as {
      components: { schemas: Record<string, unknown> };
      paths: Record<string, Record<string, { operationId: string; parameters: { name: string; in: string }[]; requestBody?: unknown }>>;
    };
    const text = JSON.stringify(doc);
    for (const m of text.matchAll(/"\$ref":"#\/components\/schemas\/(\w+)"/g)) expect(doc.components.schemas[m[1]!], m[1]).toBeTruthy();
    expect(text).not.toContain('#/$defs');
    const operationIds = Object.values(doc.paths).flatMap((p) => Object.values(p).map((o) => o.operationId));
    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining(['User', 'Report', 'ReportDetail', 'Entry', 'Photo', 'Note', 'Error', 'Notification']),
    );
    const post = doc.paths['/reports/{id}/entries']!.post!;
    expect(post.parameters).toEqual([expect.objectContaining({ name: 'id', in: 'path', required: true })]);
    expect(post.requestBody).toBeTruthy();
    const query = doc.paths['/reports']!.get!.parameters.map((p) => p.name);
    expect(query).toEqual(expect.arrayContaining(['status', 'subject_id', 'q', 'page', 'limit']));
    const upload = doc.paths['/entries/{id}/photos']!.post!.requestBody as {
      content: Record<string, { schema: { properties: Record<string, unknown> } }>;
    };
    expect(upload.content['multipart/form-data']!.schema.properties).toHaveProperty('file');
  });

  it('request schemas come from the same Zod the routes use (a field of the body is in the document)', () => {
    const doc = buildOpenApi() as {
      paths: Record<
        string,
        Record<
          string,
          { requestBody: { content: { 'application/json': { schema: { properties: Record<string, unknown>; required?: string[] } } } } }
        >
      >;
    };
    const register = doc.paths['/auth/register']!.post!.requestBody.content['application/json'].schema;
    expect(Object.keys(register.properties).sort()).toEqual(['accepted_terms', 'course', 'email', 'institution', 'name', 'password']);
    expect(register.required?.sort()).toEqual(['accepted_terms', 'email', 'name', 'password']);
  });
});

describe('what the routes answer matches the documented schemas (strict)', () => {
  // path -> the real url for the account `me`
  const url = (path: string) =>
    path
      .replace('/events/:id', `/events/${ids.event}`)
      .replace('/periods/:id', `/periods/${ids.period}`)
      .replace('/teachers/:id', `/teachers/${ids.teacher}`)
      .replace('/subjects/:id', `/subjects/${ids.subject}`)
      .replace('/reports/:id', `/reports/${ids.report}`)
      .replace('/entries/:id', `/entries/${ids.entry}`)
      .replace('/todos/:id', `/todos/${ids.todo}`)
      .replace('/photos/:id', `/photos/${ids.photo}`)
      .replace('/audios/:id', `/audios/${ids.audio}`)
      .replace('/notes/:id', `/notes/${ids.note}`)
      .replace('/attachments/:id', `/attachments/${ids.attachment}`)
      .replace('/notifications/:id', `/notifications/${ids.notification}`);

  it('every GET with a JSON schema in the registry answers exactly that shape', async () => {
    const checked: string[] = [];
    for (const e of endpoints) {
      const schema = e.responses[200];
      if (
        e.method !== 'GET' ||
        !schema ||
        typeof schema === 'string' ||
        e.path.includes('export') ||
        e.path.startsWith('/sync') ||
        e.path.startsWith('/market') ||
        e.path === '/weather'
      )
        continue;
      if (e.path === '/health' || e.path === '/openapi.json') continue;
      const r = await call(me, 'GET', url(e.path));
      expect(r.statusCode, `${e.method} ${e.path}`).toBe(200);
      const parsed = schema.safeParse(r.json());
      expect(parsed.success, `${e.path}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))}`).toBe(true);
      checked.push(e.path);
    }
    expect(checked).toEqual(
      expect.arrayContaining([
        '/users/me',
        '/periods',
        '/periods/active',
        '/subjects/:id',
        '/reports/:id',
        '/reports/:id/entries',
        '/entries/:id',
        '/notes/:id',
        '/notifications',
        '/photos/:id/info',
        '/audios/:id',
      ]),
    );
    expect(checked.length).toBeGreaterThan(20);
  });

  it('the answers of writes match too: create, change, state changes, and the health check', async () => {
    const cases: [string, ReturnType<typeof call>, { safeParse: (v: unknown) => { success: boolean; error?: { issues: unknown[] } } }][] = [
      ['health', call(null, 'GET', '/health'), E.Health],
      ['patch user', call(me, 'PATCH', '/users/me', { theme: 'dark' }), E.User],
      ['create event', call(me, 'POST', '/events', { type: 'activity', title: 'x', date: '2099-02-01' }), E.Event],
      ['patch report', call(me, 'PATCH', `/reports/${ids.report}`, { notes: 'n' }), E.ReportDetail],
      ['patch todo', call(me, 'PATCH', `/todos/${ids.todo}`, { text: 'changed' }), E.Todo],
      ['patch photo', call(me, 'PATCH', `/photos/${ids.photo}`, { caption: 'c' }), E.Photo],
      ['patch audio', call(me, 'PATCH', `/audios/${ids.audio}`, { edited_transcription: 'e' }), E.Audio],
      ['read notification', call(me, 'PATCH', `/notifications/${ids.notification}/read`), E.Notification],
      ['create teacher', call(me, 'POST', '/teachers', { name: 'T2' }), E.Teacher],
      ['create note', call(me, 'POST', '/notes', { title: 'N2', tags: ['a'] }), E.Note],
    ];
    for (const [name, promise, schema] of cases) {
      const r = await promise;
      expect(r.statusCode, name).toBeLessThan(300);
      const parsed = schema.safeParse(r.json());
      expect(parsed.success, `${name}: ${parsed.success ? '' : JSON.stringify(parsed.error?.issues.slice(0, 3))}`).toBe(true);
    }
    const auth = await call(null, 'POST', '/auth/login', { email: 'me@example.test', password: 'correct horse' });
    expect(E.AuthResult.safeParse(auth.json()).success).toBe(true);
    const refreshed = await call(null, 'POST', '/auth/refresh', { refresh_token: auth.json().refresh_token });
    expect(E.TokenPair.safeParse(refreshed.json()).success).toBe(true);
    const bad = await call(me, 'POST', '/events', { type: 'nope' });
    expect(E.ErrorBody.safeParse(bad.json()).success).toBe(true);
    const missing = await call(me, 'GET', `/events/${'3b0c9d3e-6a66-4b6a-9e0e-2f1a9c3c1d11'}`);
    expect(E.ErrorBody.safeParse(missing.json()).success).toBe(true);
  });
});

describe('security: every route, against another account', () => {
  const kind = (path: string): string | null => {
    const m = /^\/(\w+)\/:id/.exec(path);
    const map: Record<string, string> = {
      events: 'event',
      periods: 'period',
      teachers: 'teacher',
      subjects: 'subject',
      reports: 'report',
      entries: 'entry',
      todos: 'todo',
      photos: 'photo',
      audios: 'audio',
      notes: 'note',
      attachments: 'attachment',
      notifications: 'notification',
      devices: 'device',
    };
    return m ? (map[m[1]!] ?? null) : null;
  };
  const real = (path: string) => {
    const k = kind(path);
    return k ? path.replace(':id', ids[k]!) : path.replace(':id', '3b0c9d3e-6a66-4b6a-9e0e-2f1a9c3c1d11');
  };
  const protectedRoutes = endpoints.filter((e) => e.auth !== false);
  const bodyFor = (method: string) => (method === 'GET' || method === 'DELETE' ? undefined : {});

  it('without a token, every protected route answers 401 (and the public ones are exactly the six known)', async () => {
    expect(protectedRoutes.length).toBe(endpoints.length - 6);
    for (const e of protectedRoutes) {
      const r = await call(null, e.method, real(e.path), bodyFor(e.method));
      expect(r.statusCode, `${e.method} ${e.path}`).toBe(401);
    }
    // a broken, expired or foreign token is the same as none
    const forged = await call({ id: 'x', headers: { authorization: 'Bearer abc.def.ghi' } }, 'GET', '/users/me');
    expect(forged.statusCode).toBe(401);
  });

  it('with another account’s token, nothing of mine is read, changed or deleted', async () => {
    const dump = async () => JSON.stringify((await call(me, 'GET', '/users/me/export')).json().data);
    const before = await dump();
    const mine = (id: string) => id !== ids.event; // placeholder to keep the type simple
    void mine;

    for (const e of protectedRoutes) {
      if (e.method === 'DELETE' && e.path === '/users/me') continue; // it is the caller’s own account
      if (e.path.startsWith('/users/me')) continue; // own-scope routes: nothing of mine is addressed
      const r = await call(other, e.method, real(e.path), bodyFor(e.method));
      const where = `${e.method} ${e.path}`;
      expect(r.statusCode, where).toBeLessThan(500);
      expect(r.body, `${where} leaked`).not.toContain(MARK);
      if (kind(e.path)) expect(r.statusCode, `${where} must not answer 2xx for someone else’s item`).toBeGreaterThanOrEqual(400);
    }
    expect(await dump()).toBe(before); // not one row of mine changed
  });

  it('the by-id routes answer 404, not 403: the other account cannot even tell the item exists', async () => {
    const reads = endpoints.filter((e) => e.method === 'GET' && kind(e.path));
    expect(reads.length).toBeGreaterThan(15);
    for (const e of reads) {
      const r = await call(other, 'GET', real(e.path));
      expect(r.statusCode, `${e.path}`).toBe(404);
      expect(r.json().error.code).toBe('not_found');
    }
  });

  it('list routes of another account hold nothing of mine', async () => {
    for (const path of [
      '/periods',
      '/teachers',
      '/subjects?period=all',
      '/events?include_closed=true',
      '/reports?period=all&status=all',
      '/notes',
      '/notifications',
      '/search?q=zzmarkerzz',
      '/today',
      '/agenda?start=2099-01-01&end=2099-01-31',
      '/sync/changes',
      '/subjects/weekly-board',
      '/periods/active',
    ]) {
      const r = await call(other, 'GET', path);
      expect(r.body, path).not.toContain(MARK);
    }
    // and the search finds mine for me, so the test above is not empty by accident
    expect(JSON.stringify((await call(me, 'GET', '/search?q=zzmarkerzz')).json())).toContain(MARK);
  });

  it('another account cannot attach things to my items, nor point its own items at mine', async () => {
    const png1 = await png();
    for (const [url, type, name] of [
      [`/entries/${ids.entry}/photos`, 'image/png', 'a.png'],
      [`/events/${ids.event}/photos`, 'image/png', 'a.png'],
      [`/reports/${ids.report}/area-photo`, 'image/png', 'a.png'],
      [`/notes/${ids.note}/attachments`, 'image/png', 'a.png'],
    ] as const) {
      expect((await multipart(other, url, png1, type, name)).statusCode, url).toBe(404);
    }
    await call(other, 'POST', '/periods', { name: 'Other term', start_date: '2026-08-03' });
    const mineSubject = await call(other, 'POST', '/reports', { title: 'x', subject_id: ids.subject, type: 'one_off' });
    expect(mineSubject.statusCode).toBe(422);
    const mineTeacher = await call(other, 'POST', '/subjects', { name: 'x', weekdays: [1], teacher_id: ids.teacher });
    expect(mineTeacher.statusCode).toBe(422);
    const mineReport = await call(other, 'POST', `/reports/${ids.report}/entries`, {});
    expect(mineReport.statusCode).toBe(404);
  });
});

describe('uploads: real type, size and safe file names', () => {
  const treeNames = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? [n, ...treeNames(p)] : [n];
    });

  it('the name the client sends is never used: traversal names end up as generated ids under the user’s folder', async () => {
    const before = treeNames(mediaDir).length;
    for (const name of ['../../evil.png', '..\\..\\evil.png', '/etc/passwd.png', 'a/b/c.png', 'evil\u0000.png', 'x'.repeat(400) + '.png']) {
      const r = await multipart(me, `/entries/${ids.entry}/photos`, await png(), 'image/png', name);
      expect(r.statusCode, name.slice(0, 20)).toBe(201);
      const photo = r.json().items[0];
      const [rows] = await t.pool.query<RowDataPacket[]>('SELECT arquivo, miniatura FROM foto WHERE id = ?', [photo.id]);
      expect(rows[0]!.arquivo).toBe(join(me.id, 'fotos', `${photo.id}.png`));
      expect(rows[0]!.miniatura).toBe(join(me.id, 'fotos', `${photo.id}_thumb.jpg`));
      expect(existsSync(join(mediaDir, rows[0]!.arquivo as string))).toBe(true);
      await call(me, 'DELETE', `/photos/${photo.id}`);
    }
    const names = treeNames(mediaDir);
    expect(names.some((n) => n.includes('evil') || n.includes('passwd'))).toBe(false);
    expect(existsSync(join(mediaDir, '..', 'evil.png'))).toBe(false);
    expect(names.length).toBe(before); // everything uploaded was deleted again: nothing left behind
  });

  it('the media folder refuses paths that leave it', async () => {
    const media = new MediaStorage(mediaDir);
    expect(() => media.stream('../outside.txt')).toThrow('outside');
    expect(() => media.stream(`${me.id}/../../outside.txt`)).toThrow('outside');
    await expect(media.read('../../etc/passwd')).rejects.toThrow('outside');
    await expect(media.remove(['../../important.txt'])).rejects.toThrow('outside');
  });

  it('the type comes from the bytes, whatever the name or the declared type say', async () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    for (const [url, field] of [
      [`/entries/${ids.entry}/photos`, 'image/png'],
      [`/notes/${ids.note}/attachments`, 'application/pdf'],
    ] as const) {
      const r = await multipart(me, url, html, field, 'innocent.png');
      expect(r.statusCode, url).toBe(422);
    }
    const fakeAudio = await multipart(me, `/entries/${ids.entry}/audios`, html, 'audio/ogg', 'x.ogg', {
      duration_s: '5',
      recorded_at: '2026-11-03T11:00:00Z',
    });
    expect(fakeAudio.statusCode).toBe(422);
    // an executable pretending to be a PDF
    expect(
      (await multipart(me, `/notes/${ids.note}/attachments`, Buffer.from('MZ\x90\x00 program'), 'application/pdf', 'a.pdf')).statusCode,
    ).toBe(422);
  });

  it('size limits: photos, attachments and audios above 10 MB are 413', async () => {
    const big = Buffer.concat([await png(), Buffer.alloc(10 * 1024 * 1024)]);
    expect((await multipart(me, `/entries/${ids.entry}/photos`, big, 'image/png', 'big.png')).statusCode).toBe(413);
    expect(
      (
        await multipart(
          me,
          `/notes/${ids.note}/attachments`,
          Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(10 * 1024 * 1024)]),
          'application/pdf',
          'big.pdf',
        )
      ).statusCode,
    ).toBe(413);
    const bigAudio = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(10 * 1024 * 1024)]);
    expect(
      (
        await multipart(me, `/entries/${ids.entry}/audios`, bigAudio, 'audio/ogg', 'big.ogg', {
          duration_s: '5',
          recorded_at: '2026-11-03T11:00:00Z',
        })
      ).statusCode,
    ).toBe(413);
    // a JSON body that is too large is refused as well, with the standard error
    const huge = await call(me, 'POST', '/notes', { title: 'x', text: 'a'.repeat(2 * 1024 * 1024) });
    expect(huge.statusCode).toBe(413);
    expect(E.ErrorBody.safeParse(huge.json()).success).toBe(true);
  });

  it('files are served with the real type, never sniffed, only to the owner', async () => {
    const r = await call(me, 'GET', `/photos/${ids.photo}`);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toContain('private');
    const pdf = await call(me, 'GET', `/attachments/${ids.attachment}`);
    expect(pdf.headers['content-disposition']).toBe('attachment');
  });

  it('download names are made of safe characters, whatever the title is', async () => {
    const nasty = 'Relatório "ç" \r\nX-Evil: 1; filename=../../x ‮ ' + '\u0000';
    const id = (await call(me, 'POST', '/reports', { title: nasty.slice(0, 160), subject_id: ids.subject, type: 'one_off' })).json().id;
    for (const format of ['text', 'csv', 'zip']) {
      const r = await call(me, 'GET', `/reports/${id}/export?format=${format}`);
      expect(r.statusCode).toBe(200);
      const header = String(r.headers['content-disposition']);
      expect(header, format).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"$/);
      expect(Object.keys(r.headers).some((k) => k.toLowerCase() === 'x-evil')).toBe(false);
    }
    const summary = await call(me, 'GET', `/periods/${ids.period}/summary?format=text`);
    expect(String(summary.headers['content-disposition'])).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"$/);
  });
});

describe('logs never carry secrets', () => {
  it('no password, token, refresh token, hash, exact coordinate or SQL text reaches the log, even on an internal error', async () => {
    const lines: string[] = [];
    const net = new FakeNetwork();
    const market = new MarketService(t.pool, net.fetch, {
      openWeatherKey: 'topsecretkey123',
      defaultLatitude: -10.19,
      defaultLongitude: -48.31,
    });
    const logged = createTestApp(t.pool, true, mkdtempSync(join(tmpdir(), 'caderno-log-')), market, {
      log: true,
      logStream: { write: (chunk: string) => lines.push(chunk) },
    });
    // a route that fails like a database error: the message carries the SQL with the values
    logged.get('/boom', async () => {
      const error = Object.assign(new Error("Duplicate entry 'secret@mail.test' for key 'usuario_email_unico'"), {
        code: 'ER_UNKNOWN',
        errno: 1,
        sqlState: '23000',
        sql: "INSERT INTO usuario (senha_hash) VALUES ('$argon2id$v=19$LEAKEDHASH')",
      });
      throw error;
    });
    await logged.ready();

    const password = 'S3cretPassw0rd!';
    const registered = await logged.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { name: 'Logger', email: 'logger@example.test', password, accepted_terms: true },
    });
    const { access_token, refresh_token } = registered.json();
    const headers = { authorization: `Bearer ${access_token}` };
    const login = await logged.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'logger@example.test', password: 'wrong-' + password },
    });
    expect(login.statusCode).toBe(401);
    await logged.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refresh_token } });
    await logged.inject({ method: 'GET', url: '/api/v1/weather?lat=-10.123456&lon=-48.654321', headers });
    await logged.inject({ method: 'GET', url: '/api/v1/market/summary?lat=-10.123456&lon=-48.654321', headers });
    await logged.inject({ method: 'GET', url: '/api/v1/today?lat=-10.123456&lon=-48.654321', headers });
    const boom = await logged.inject({ method: 'GET', url: '/boom?lat=-10.123456&lon=-48.654321', headers });
    expect(boom.statusCode).toBe(500);
    expect(boom.body).not.toContain('Duplicate'); // the answer to the client does not leak either
    await logged.close();

    const log = lines.join('');
    expect(log.length).toBeGreaterThan(200);
    expect(log).toContain('/api/v1/weather'); // the path is there, so the log is useful
    for (const secret of [
      password,
      access_token,
      refresh_token,
      'topsecretkey123',
      '-10.123456',
      '-48.654321',
      'LEAKEDHASH',
      'argon2id',
      'secret@mail.test',
      'INSERT INTO usuario',
      'senha_hash',
      'authorization',
      'Bearer ',
    ]) {
      expect(log, `the log has "${secret.slice(0, 12)}"`).not.toContain(secret);
    }
    expect(log).toContain('internal error'); // the failure itself is logged, without the private parts
  });
});

describe('api.md and the code say the same', () => {
  const doc = readFileSync(new URL('../../../docs/api.md', import.meta.url), 'utf8');

  const documented = (() => {
    const found = new Set<string>();
    const add = (method: string, path: string) => {
      const clean = path
        .split('?')[0]!
        .replace(/\{(\w+)\}/g, ':$1')
        .replace(/\/$/, '');
      found.add(`${method} ${clean}`);
    };
    for (const m of doc.matchAll(/^\|\s*(GET|POST|PATCH|DELETE)\s*\|\s*`(\/[^`]+)`/gm)) add(m[1]!, m[2]!);
    for (const m of doc.matchAll(/^###\s+(GET|POST|PATCH|DELETE)\s+`(\/[^`]+)`/gm)) add(m[1]!, m[2]!);
    for (const m of doc.matchAll(/`(GET|POST|PATCH|DELETE) (\/[^`\s]+)`/g)) add(m[1]!, m[2]!);
    return found;
  })();

  // planned and written in the doc, not built yet (checklist 1.1 and the push)
  const NOT_BUILT_YET = new Set(['POST /auth/forgot-password', 'POST /auth/reset-password', 'POST /transcribe']);

  it('every route of the code is in api.md', () => {
    const missing = endpoints.map((e) => `${e.method} ${e.path}`).filter((key) => !documented.has(key));
    expect(missing).toEqual([]);
  });

  it('every route in api.md exists in the code (except the ones announced as not built yet)', () => {
    const inCode = new Set(endpoints.map((e) => `${e.method} ${e.path}`));
    const ghosts = [...documented].filter((key) => !inCode.has(key) && !NOT_BUILT_YET.has(key));
    expect(ghosts).toEqual([]);
  });

  it('the document does not keep the old Portuguese routes', () => {
    for (const old of [
      '/auth/cadastro',
      '/periodos',
      '/materias',
      '/professores',
      '/relatorios',
      '/registros',
      '/anotacoes',
      '/notificacoes',
      '/mercado/',
      '/sync/enviar',
      '/sync/mudancas',
      '/sync/midia',
      '/sync/estado',
      '/hoje',
      '/busca',
      '/usuarios/me',
      '/fotos/',
    ]) {
      const lines = doc.split(String.fromCharCode(10)).filter((l) => l.includes(`\`${old}`));
      expect(lines, old).toEqual([]);
    }
  });
});
