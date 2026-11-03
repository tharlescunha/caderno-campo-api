import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MarketScheduler } from '../src/market/scheduler.js';
import { MarketService } from '../src/market/service.js';
import { FakeNetwork } from './fake-network.js';
import { createTestApp, createTestDatabase, registerUser, type TestDatabase, type TestUser } from './helpers.js';

let t: TestDatabase;
let app: FastifyInstance;
let me: TestUser;
let other: TestUser;
let net: FakeNetwork;
let market: MarketService;

const uid = () => randomUUID();
const call = (user: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: user.headers, ...(payload === undefined ? {} : { payload: payload as object }) });

interface Op {
  operation_id?: string;
  entity: string;
  operation: 'create' | 'update' | 'delete' | 'close_period';
  id: string;
  data?: Record<string, unknown>;
  base_version?: number;
  base_data?: Record<string, unknown>;
  done_at?: string;
}
const withIds = (ops: Op[]) => ops.map((o) => ({ operation_id: uid(), ...o }));
const send = async (user: TestUser, ops: Op[], deviceId?: string) => {
  const r = await call(user, 'POST', '/sync/send', { ...(deviceId ? { device_id: deviceId } : {}), operations: withIds(ops) });
  return r;
};
const sendSame = (user: TestUser, operations: unknown[]) => call(user, 'POST', '/sync/send', { operations });
const changes = async (user: TestUser, cursor?: string, limit = 200) =>
  (await call(user, 'GET', `/sync/changes?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`)).json();
const png = () =>
  sharp({ create: { width: 48, height: 48, channels: 3, background: { r: 1, g: 100, b: 20 } } })
    .png()
    .toBuffer();

async function media(user: TestUser, fields: Record<string, string>, data: Buffer, type = 'image/png') {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(data)], { type }), 'f');
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const response = new Response(form);
  return app.inject({
    method: 'POST',
    url: '/api/v1/sync/media',
    headers: { ...user.headers, 'content-type': response.headers.get('content-type')! },
    payload: Buffer.from(await response.arrayBuffer()),
  });
}

beforeAll(async () => {
  t = await createTestDatabase();
  net = new FakeNetwork();
  market = new MarketService(t.pool, net.fetch, { openWeatherKey: 'k', defaultLatitude: -10.19, defaultLongitude: -48.31 });
  app = createTestApp(t.pool, true, mkdtempSync(join(tmpdir(), 'caderno-sync-')), market);
  me = await registerUser(app, 'me@example.test');
  other = await registerUser(app, 'other@example.test');
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

describe('an offline session sent in one go', () => {
  const ids = {
    period: uid(),
    teacher: uid(),
    subject: uid(),
    event: uid(),
    report: uid(),
    e1: uid(),
    e2: uid(),
    e3: uid(),
    note: uid(),
    todo1: uid(),
  };
  let batch: ReturnType<typeof withIds>;

  it('applies create operations in order: period, teacher, subject, event, report, three entries, note', async () => {
    batch = withIds([
      { entity: 'period', operation: 'create', id: ids.period, data: { name: '5th term', start_date: '2026-08-03' } },
      { entity: 'teacher', operation: 'create', id: ids.teacher, data: { name: 'Profª Rita' } },
      {
        entity: 'subject',
        operation: 'create',
        id: ids.subject,
        data: { period_id: ids.period, name: 'Phytopathology', teacher_id: ids.teacher, weekdays: [2], class_type: 'field' },
      },
      {
        entity: 'event',
        operation: 'create',
        id: ids.event,
        data: { type: 'exam', title: 'Exam', subject_id: ids.subject, date: '2026-12-01', reminder: '1_day' },
      },
      {
        entity: 'report',
        operation: 'create',
        id: ids.report,
        data: { title: 'Corn plot', subject_id: ids.subject, type: 'continuous', delivery_date: '2026-12-10' },
      },
      {
        entity: 'entry',
        operation: 'create',
        id: ids.e1,
        data: {
          report_id: ids.report,
          status: 'completed',
          recorded_at: '2026-11-03T11:00:00Z',
          next_visit: [{ id: ids.todo1, text: 'Measure plants' }],
        },
      },
      {
        entity: 'entry',
        operation: 'create',
        id: ids.e2,
        data: { report_id: ids.report, status: 'completed', recorded_at: '2026-11-10T11:00:00Z', todos_done: [ids.todo1] },
      },
      {
        entity: 'entry',
        operation: 'create',
        id: ids.e3,
        data: { report_id: ids.report, status: 'draft', recorded_at: '2026-11-17T11:00:00Z', notes: 'draft' },
      },
      {
        entity: 'note',
        operation: 'create',
        id: ids.note,
        data: { title: 'A note', text: 'first text', subject_id: ids.subject, tags: ['x'] },
      },
    ] as Op[]);
    const r = await sendSame(me, batch);
    expect(r.statusCode).toBe(200);
    const { results, cursor } = r.json();
    expect(results.map((x: { status: string }) => x.status)).toEqual(Array(9).fill('ok'));
    expect(results.map((x: { operation_id: string }) => x.operation_id)).toEqual(batch.map((b) => b.operation_id));
    expect(results[0].version).toBe(1);
    expect(cursor).toMatch(/^\d{9}$/);

    // everything arrived once, with the ids the phone made up
    expect((await call(me, 'GET', `/periods/${ids.period}`)).json().name).toBe('5th term');
    expect((await call(me, 'GET', `/subjects/${ids.subject}`)).json().teacher.id).toBe(ids.teacher);
    expect((await call(me, 'GET', `/reports/${ids.report}`)).json().totals.entries).toBe(3);
    const todo = (await call(me, 'GET', `/todos/${ids.todo1}`)).json();
    expect(todo).toMatchObject({ id: ids.todo1, text: 'Measure plants', done: true, done_in_entry_id: ids.e2 });
    expect((await call(me, 'GET', '/events?type=report_delivery')).json().total).toBe(1);
  });

  it('sending the same batch again changes nothing: every operation is "already_processed"', async () => {
    const before = (await t.pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM mudanca WHERE usuario_id = ?', [me.id]))[0][0]!.n;
    const r = await sendSame(me, batch);
    expect(r.json().results.map((x: { status: string }) => x.status)).toEqual(Array(9).fill('already_processed'));
    expect((await t.pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM mudanca WHERE usuario_id = ?', [me.id]))[0][0]!.n).toBe(before);
    expect((await call(me, 'GET', '/reports')).json().total).toBe(1);
    expect((await call(me, 'GET', `/reports/${ids.report}/entries`)).json().total).toBe(3);
  });

  it('a batch cut half way: the confirmed operations do not repeat, the rest go through', async () => {
    const a = uid();
    const b = uid();
    const first = withIds([{ entity: 'note', operation: 'create', id: a, data: { title: 'A' } }] as Op[]);
    await sendSame(me, first);
    const second = [...first, ...withIds([{ entity: 'note', operation: 'create', id: b, data: { title: 'B' } }] as Op[])];
    const r = (await sendSame(me, second)).json();
    expect(r.results.map((x: { status: string }) => x.status)).toEqual(['already_processed', 'ok']);
    expect((await call(me, 'GET', '/notes?q=A')).json().total).toBeGreaterThanOrEqual(1);
  });

  it('operation ids are per user: the same id from another account is a new operation', async () => {
    const shared = uid();
    const op = (id: string) => [{ operation_id: shared, entity: 'note', operation: 'create', id, data: { title: 'Same op id' } }];
    expect((await sendSame(me, op(uid()))).json().results[0].status).toBe('ok');
    expect((await sendSame(other, op(uid()))).json().results[0].status).toBe('ok');
  });

  it('a repeat of a create with a new operation id but the same item id returns the item that exists', async () => {
    const r = (await send(me, [{ entity: 'note', operation: 'create', id: ids.note, data: { title: 'would be a duplicate' } }])).json();
    expect(r.results[0]).toMatchObject({ status: 'ok', version: 1 });
    expect((await call(me, 'GET', `/notes/${ids.note}`)).json().title).toBe('A note'); // the existing item is untouched
  });

  it('create and delete in the same batch leave nothing; deleting what is gone is fine', async () => {
    const id = uid();
    const r = (
      await send(me, [
        { entity: 'note', operation: 'create', id, data: { title: 'Gone soon' } },
        { entity: 'note', operation: 'delete', id },
        { entity: 'note', operation: 'delete', id },
      ])
    ).json();
    expect(r.results.map((x: { status: string }) => x.status)).toEqual(['ok', 'ok', 'ok']);
    expect((await call(me, 'GET', `/notes/${id}`)).statusCode).toBe(404);
  });

  it('photos and audios go through /sync/media, once per id, in the right place', async () => {
    const photoId = uid();
    const fields = { entity: 'entry', entity_id: ids.e1, photo_id: photoId, caption: 'leaf', taken_at: '2026-11-03T11:05:00Z' };
    const first = await media(me, fields, await png());
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ status: 'ok', item: { id: photoId, entry_id: ids.e1, caption: 'leaf' } });
    const again = await media(me, fields, await png());
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ status: 'already_processed', item: { id: photoId } });
    expect((await call(me, 'GET', `/entries/${ids.e1}`)).json().photos).toHaveLength(1);

    const area = await media(me, { entity: 'report_area', entity_id: ids.report, photo_id: uid() }, await png());
    expect(area.statusCode).toBe(201);
    const audioId = uid();
    const audio = await media(
      me,
      { entity: 'entry_audio', entity_id: ids.e1, audio_id: audioId, duration_s: '9', recorded_at: '2026-11-03T11:06:00Z' },
      Buffer.concat([Buffer.from('OggS'), Buffer.alloc(300)]),
      'audio/ogg',
    );
    expect(audio.json()).toMatchObject({ status: 'ok', item: { id: audioId, status: 'transcribing' } });
    const attachmentId = uid();
    const att = await media(
      me,
      { entity: 'note', entity_id: ids.note, attachment_id: attachmentId },
      Buffer.from('%PDF-1.4 x'),
      'application/pdf',
    );
    expect(att.statusCode).toBe(201);
    expect(att.json().item.id).toBe(attachmentId);
    expect(
      (
        await media(me, { entity: 'note', entity_id: ids.note, attachment_id: attachmentId }, Buffer.from('%PDF-1.4 x'), 'application/pdf')
      ).json().status,
    ).toBe('already_processed');
  });

  it('media validation: unknown kind, someone else’s item, not an image', async () => {
    expect((await media(me, { entity: 'planet', entity_id: ids.e1 }, await png())).statusCode).toBe(422);
    expect((await media(other, { entity: 'entry', entity_id: ids.e1, photo_id: uid() }, await png())).statusCode).toBe(404);
    expect((await media(me, { entity: 'entry', entity_id: ids.e1 }, Buffer.from('not an image'))).statusCode).toBe(422);
  });
});

describe('errors do not stop the batch', () => {
  it('a validation error is reported with its fields and the next operations still run; dependants fail with "dependency"', async () => {
    const report = uid();
    const entry = uid();
    const note = uid();
    const r = (
      await send(me, [
        { entity: 'report', operation: 'create', id: report, data: { title: '', subject_id: uid(), type: 'continuous' } },
        { entity: 'entry', operation: 'create', id: entry, data: { report_id: report, notes: 'orphan' } },
        { entity: 'note', operation: 'create', id: note, data: { title: 'Still goes' } },
      ])
    ).json();
    expect(r.results[0]).toMatchObject({ status: 'error', code: 'validation' });
    expect(r.results[0].fields.map((f: { field: string }) => f.field)).toContain('title');
    expect(r.results[1]).toMatchObject({ status: 'error', code: 'dependency' });
    expect(r.results[2].status).toBe('ok');
    expect((await call(me, 'GET', `/notes/${note}`)).statusCode).toBe(200);
  });

  it('batch size and shape', async () => {
    expect((await call(me, 'POST', '/sync/send', { operations: [] })).statusCode).toBe(422);
    const many = Array.from({ length: 51 }, () => ({
      operation_id: uid(),
      entity: 'note',
      operation: 'create',
      id: uid(),
      data: { title: 'x' },
    }));
    expect((await sendSame(me, many)).statusCode).toBe(422);
    expect((await sendSame(me, many.slice(0, 50))).json().results).toHaveLength(50);
    expect(
      (await call(me, 'POST', '/sync/send', { operations: [{ operation_id: 'nope', entity: 'planet', operation: 'create', id: uid() }] }))
        .statusCode,
    ).toBe(422);
  });

  it('what the batch does not cover is "unsupported"', async () => {
    const r = (
      await send(me, [
        { entity: 'photo', operation: 'create', id: uid(), data: {} },
        { entity: 'user', operation: 'delete', id: me.id },
      ])
    ).json();
    expect(r.results.map((x: { code: string }) => x.code)).toEqual(['unsupported', 'unsupported']);
  });

  it('a business rule of the normal routes also holds in sync (finished period is read-only)', async () => {
    const period = uid();
    await send(me, [
      { entity: 'period', operation: 'create', id: period, data: { name: 'Old', start_date: '2020-01-01', confirm_closing: true } },
    ]);
    const subject = uid();
    await send(me, [{ entity: 'subject', operation: 'create', id: subject, data: { period_id: period, name: 'S', weekdays: [1] } }]);
    await send(me, [
      { entity: 'period', operation: 'create', id: uid(), data: { name: 'Newer', start_date: '2020-02-01', confirm_closing: true } },
    ]);
    const r = (await send(me, [{ entity: 'subject', operation: 'update', id: subject, data: { name: 'Changed' } }])).json();
    expect(r.results[0]).toMatchObject({ status: 'error', code: 'period_finished' });
  });
});

describe('edit conflicts (offline.md, section 4)', () => {
  const note = uid();
  let base: number;

  beforeAll(async () => {
    await send(me, [{ entity: 'note', operation: 'create', id: note, data: { title: 'Title', text: 'original text', pinned: false } }]);
    base = (await call(me, 'GET', `/notes/${note}`)).json().version;
  });

  it('no one else touched it: applied, no conflict, version goes up', async () => {
    const r = (await send(me, [{ entity: 'note', operation: 'update', id: note, base_version: base, data: { pinned: true } }])).json();
    expect(r.results[0]).toMatchObject({ status: 'ok' });
    base = r.results[0].version;
    expect(base).toBeGreaterThan(1);
  });

  it('different fields on each side: both are kept (needs base_data to know what the phone changed)', async () => {
    const known = base;
    await call(me, 'PATCH', `/notes/${note}`, { title: 'Edited on the site' }); // the site
    const r = (
      await send(me, [
        {
          entity: 'note',
          operation: 'update',
          id: note,
          base_version: known,
          base_data: { text: 'original text' },
          data: { text: 'edited on the phone' },
          done_at: '2020-01-01T00:00:00Z',
        },
      ])
    ).json();
    expect(r.results[0].status).toBe('ok');
    const n = (await call(me, 'GET', `/notes/${note}`)).json();
    expect(n).toMatchObject({ title: 'Edited on the site', text: 'edited on the phone' });
    base = n.version;
  });

  it('same text on both sides, the phone’s edit is newer: the phone wins and the server text goes to the history', async () => {
    const known = base;
    await call(me, 'PATCH', `/notes/${note}`, { text: 'site text' });
    const r = (
      await send(me, [
        {
          entity: 'note',
          operation: 'update',
          id: note,
          base_version: known,
          base_data: { text: 'edited on the phone' },
          data: { text: 'phone text, later' },
          done_at: new Date(Date.now() + 60000).toISOString(),
        },
      ])
    ).json();
    expect(r.results[0]).toMatchObject({ status: 'conflict', applied_fields: ['text'], ignored_fields: [] });
    expect(r.results[0].server_version).toBeLessThan(r.results[0].version);
    const n = (await call(me, 'GET', `/notes/${note}`)).json();
    expect(n.text).toBe('phone text, later');
    expect(n.text_history).toEqual([expect.objectContaining({ field: 'text', text: 'site text' })]);
    base = n.version;
  });

  it('same text on both sides, the site’s edit is newer: the site wins and the phone text goes to the history', async () => {
    const known = base;
    await call(me, 'PATCH', `/notes/${note}`, { text: 'site text, later' });
    const r = (
      await send(me, [
        {
          entity: 'note',
          operation: 'update',
          id: note,
          base_version: known,
          base_data: { text: 'phone text, later', pinned: true },
          data: { text: 'phone text, old edit', pinned: false },
          done_at: '2020-01-01T00:00:00Z',
        },
      ])
    ).json();
    expect(r.results[0]).toMatchObject({ status: 'conflict', ignored_fields: ['text'] });
    expect(r.results[0].item.text).toBe('site text, later');
    const n = (await call(me, 'GET', `/notes/${note}`)).json();
    expect(n.pinned).toBe(false); // the field nobody else changed still went through
    expect(n.text_history.map((h: { text: string }) => h.text)).toEqual(expect.arrayContaining(['phone text, old edit', 'site text']));
    expect(n.text_history).toHaveLength(2); // nothing was lost
  });

  it('without base_data every changed field counts as a conflict; the newer side wins', async () => {
    const known = (await call(me, 'GET', `/notes/${note}`)).json().version;
    await call(me, 'PATCH', `/notes/${note}`, { title: 'Site title' });
    const r = (
      await send(me, [
        {
          entity: 'note',
          operation: 'update',
          id: note,
          base_version: known,
          data: { title: 'Phone title' },
          done_at: '2020-01-01T00:00:00Z',
        },
      ])
    ).json();
    expect(r.results[0]).toMatchObject({ status: 'conflict', ignored_fields: ['title'] });
    expect((await call(me, 'GET', `/notes/${note}`)).json().title).toBe('Site title');
  });

  it('a value that both sides already agree on is not a conflict', async () => {
    const known = (await call(me, 'GET', `/notes/${note}`)).json().version;
    await call(me, 'PATCH', `/notes/${note}`, { title: 'Same on both' });
    const r = (
      await send(me, [{ entity: 'note', operation: 'update', id: note, base_version: known - 1, data: { title: 'Same on both' } }])
    ).json();
    expect(r.results[0].status).toBe('ok');
  });

  it('updating something that does not exist (any more) is an error the phone can show', async () => {
    const r = (await send(me, [{ entity: 'note', operation: 'update', id: uid(), data: { title: 'x' } }])).json();
    expect(r.results[0]).toMatchObject({ status: 'error', code: 'not_found' });
  });

  it('report finish/reopen travel as "status"; a tag-only change counts as a change', async () => {
    const report = uid();
    const subject = (await call(me, 'POST', '/subjects', { name: 'Sync subject', weekdays: [1] })).json().id; // in the active period
    await send(me, [{ entity: 'report', operation: 'create', id: report, data: { title: 'R', subject_id: subject, type: 'continuous' } }]);
    const v1 = (await call(me, 'GET', `/reports/${report}`)).json().version;
    const r = (await send(me, [{ entity: 'report', operation: 'update', id: report, data: { status: 'finished' } }])).json();
    expect(r.results[0].status).toBe('ok');
    expect((await call(me, 'GET', `/reports/${report}`)).json().status).toBe('finished');
    await send(me, [{ entity: 'report', operation: 'update', id: report, data: { status: 'in_progress' } }]);
    expect((await call(me, 'GET', `/reports/${report}`)).json().status).toBe('in_progress');
    await call(me, 'PATCH', `/reports/${report}`, { tags: ['only-tags'] });
    expect((await call(me, 'GET', `/reports/${report}`)).json().version).toBeGreaterThan(v1);
  });
});

describe('closing a period from the phone', () => {
  it('runs the same cascade, keeps everything, and repeating is fine', async () => {
    const user = await registerUser(app, 'closer@example.test');
    const period = uid();
    const subject = uid();
    const report = uid();
    const event = uid();
    await send(user, [
      { entity: 'period', operation: 'create', id: period, data: { name: 'P', start_date: '2026-08-03' } },
      { entity: 'subject', operation: 'create', id: subject, data: { period_id: period, name: 'S', weekdays: [2] } },
      { entity: 'report', operation: 'create', id: report, data: { title: 'R', subject_id: subject, type: 'continuous' } },
      { entity: 'event', operation: 'create', id: event, data: { type: 'exam', title: 'Future', subject_id: subject, date: '2099-01-01' } },
    ]);
    const close = { entity: 'period', operation: 'close_period', id: period } as const;
    expect((await send(user, [close])).json().results[0].status).toBe('ok');
    expect((await call(user, 'GET', `/periods/${period}`)).json().status).toBe('finished');
    expect((await call(user, 'GET', `/reports/${report}`)).json()).toMatchObject({ status: 'finished', finished_by: 'period' });
    expect((await call(user, 'GET', `/events/${event}`)).json().closed_with_period).toBe(true);
    expect((await call(user, 'GET', `/subjects/${subject}`)).statusCode).toBe(200); // nothing was deleted
    expect((await send(user, [close])).json().results[0].status).toBe('ok'); // new operation id, already closed
    expect((await send(user, [{ entity: 'subject', operation: 'close_period', id: subject }])).json().results[0].code).toBe('unsupported');
  });
});

describe('what changed on the server', () => {
  let user: TestUser;
  const ids = { period: uid(), subject: uid(), report: uid(), entry: uid(), todo: uid(), note: uid() };

  beforeAll(async () => {
    user = await registerUser(app, 'newphone@example.test');
    await send(user, [
      { entity: 'period', operation: 'create', id: ids.period, data: { name: 'P', start_date: '2026-08-03' } },
      { entity: 'subject', operation: 'create', id: ids.subject, data: { period_id: ids.period, name: 'S', weekdays: [2] } },
      { entity: 'report', operation: 'create', id: ids.report, data: { title: 'R', subject_id: ids.subject, type: 'continuous' } },
      {
        entity: 'entry',
        operation: 'create',
        id: ids.entry,
        data: { report_id: ids.report, status: 'completed', next_visit: [{ id: ids.todo, text: 'do' }] },
      },
      { entity: 'note', operation: 'create', id: ids.note, data: { title: 'N', tags: ['t'] } },
    ]);
  });

  it('a new phone asks for everything (no cursor): pages, parents before children, then it is up to date', async () => {
    const all: { entity: string; operation: string; id: string; item?: Record<string, unknown> }[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await changes(user, cursor, 3);
      all.push(...page.changes);
      cursor = page.cursor;
      pages++;
      if (!page.has_more) break;
    }
    expect(pages).toBeGreaterThan(1);
    const seen = all.map((c) => `${c.entity}`);
    expect(new Set(seen)).toEqual(new Set(['user', 'period', 'subject', 'report', 'entry', 'todo', 'note']));
    // a child never comes before its parent
    const index = (entity: string) => all.findIndex((c) => c.entity === entity);
    expect(index('period')).toBeLessThan(index('subject'));
    expect(index('subject')).toBeLessThan(index('report'));
    expect(index('report')).toBeLessThan(index('entry'));
    expect(index('entry')).toBeLessThan(index('todo'));
    const entry = all.find((c) => c.entity === 'entry')!;
    expect(entry).toMatchObject({ operation: 'upsert', id: ids.entry });
    expect(entry.item).toMatchObject({ id: ids.entry, report_id: ids.report, version: expect.any(Number) });
    expect((all.find((c) => c.entity === 'note')!.item as { tags: string[] }).tags).toEqual(['t']);
    expect(cursor).toMatch(/^\d{9}$/);

    const empty = await changes(user, cursor);
    expect(empty).toMatchObject({ changes: [], has_more: false, cursor });
  });

  it('later changes arrive as one entry per item, with the value now; tags and weekdays move their parent', async () => {
    const start = (await changes(user)).cursor === undefined ? undefined : (await call(user, 'GET', '/sync/state')).json().current_cursor;
    await call(user, 'PATCH', `/notes/${ids.note}`, { title: 'N1' });
    await call(user, 'PATCH', `/notes/${ids.note}`, { title: 'N2' });
    await call(user, 'PATCH', `/notes/${ids.note}`, { tags: ['new'] });
    await call(user, 'PATCH', `/subjects/${ids.subject}`, { weekdays: [3, 4] });
    const page = await changes(user, start);
    expect(page.changes.map((c: { entity: string }) => c.entity).sort()).toEqual(['note', 'subject']);
    const note = page.changes.find((c: { entity: string }) => c.entity === 'note');
    expect(note.item).toMatchObject({ title: 'N2', tags: ['new'] });
    expect(page.changes.find((c: { entity: string }) => c.entity === 'subject').item.weekdays).toEqual([3, 4]);
  });

  it('deleting a report reports the delete of everything the cascade took with it', async () => {
    const start = (await call(user, 'GET', '/sync/state')).json().current_cursor;
    await call(user, 'DELETE', `/reports/${ids.report}`);
    const page = await changes(user, start);
    const deleted = page.changes
      .filter((c: { operation: string }) => c.operation === 'delete')
      .map((c: { entity: string; id: string }) => `${c.entity}:${c.id}`);
    expect(deleted).toEqual(expect.arrayContaining([`report:${ids.report}`, `entry:${ids.entry}`, `todo:${ids.todo}`]));
    expect(page.changes.every((c: { operation: string }) => c.operation === 'delete' || c.operation === 'upsert')).toBe(true);
  });

  it('deletes made elsewhere also arrive for a single item, and a change that was deleted later is just a delete', async () => {
    const start = (await call(user, 'GET', '/sync/state')).json().current_cursor;
    const id = uid();
    await send(user, [{ entity: 'note', operation: 'create', id, data: { title: 'short life' } }]);
    await call(user, 'DELETE', `/notes/${id}`);
    const page = await changes(user, start);
    expect(page.changes.filter((c: { id: string }) => c.id === id)).toEqual([{ entity: 'note', operation: 'delete', id }]);
  });

  it('profile changes arrive as "user"', async () => {
    const start = (await call(user, 'GET', '/sync/state')).json().current_cursor;
    await call(user, 'PATCH', '/users/me', { theme: 'dark' });
    const page = await changes(user, start);
    expect(page.changes.find((c: { entity: string }) => c.entity === 'user').item.theme).toBe('dark');
    // and the phone can change its settings through sync
    const r = (await send(user, [{ entity: 'user', operation: 'update', id: user.id, data: { remind_record_time: '19:00' } }])).json();
    expect(r.results[0].status).toBe('ok');
  });

  it('a record the server completes later (weather) reaches the phone as a change', async () => {
    const subject = (await call(user, 'GET', '/subjects?period=all')).json().items[0].id;
    const report = uid();
    await send(user, [
      { entity: 'report', operation: 'create', id: report, data: { title: 'Weather', subject_id: subject, type: 'continuous' } },
    ]);
    net.noWeather = true;
    const entry = uid();
    await t.pool.query('DELETE FROM mercado_cache');
    await send(user, [
      { entity: 'entry', operation: 'create', id: entry, data: { report_id: report, latitude: -10.2491, longitude: -48.3243 } },
    ]);
    expect((await call(user, 'GET', `/entries/${entry}`)).json()).toMatchObject({ weather_origin: 'pending', weather: null });
    const start = (await call(user, 'GET', '/sync/state')).json().current_cursor;

    net.noWeather = false;
    await t.pool.query('DELETE FROM mercado_cache');
    expect(await new MarketScheduler(t.pool, market).fillPendingWeather()).toBe(1);
    const page = await changes(user, start);
    const change = page.changes.find((c: { id: string }) => c.id === entry);
    expect(change.item).toMatchObject({ weather_origin: 'gps', weather: { temperature_c: 36.6 } });
  });

  it('the cursor and the state', async () => {
    const state = (await call(user, 'GET', '/sync/state')).json();
    expect(state).toMatchObject({ min_app_version: '1.0.0' });
    expect(state.current_cursor).toMatch(/^\d{9}$/);
    expect(Math.abs(Date.now() - Date.parse(state.server_time))).toBeLessThan(5000);
    expect((await call(user, 'GET', '/sync/changes?cursor=abc')).statusCode).toBe(422);
    expect((await call(user, 'GET', '/sync/changes?limit=0')).statusCode).toBe(422);
  });
});

describe('isolation and the removed account', () => {
  it('another account sees none of my changes and cannot change my items through sync', async () => {
    const mine = (await changes(me)).changes.length;
    expect(mine).toBeGreaterThan(5);
    const otherChanges = (await changes(other)).changes.map((c: { entity: string }) => c.entity);
    expect(otherChanges.sort()).toEqual(['note', 'user']); // its own profile and the note it made in an earlier test
    const note = (await call(me, 'GET', '/notes')).json().items[0].id;
    const r = (
      await send(other, [
        { entity: 'note', operation: 'update', id: note, data: { title: 'hacked' } },
        { entity: 'note', operation: 'delete', id: note },
      ])
    ).json();
    expect(r.results[0]).toMatchObject({ status: 'error', code: 'not_found' });
    expect((await call(me, 'GET', `/notes/${note}`)).statusCode).toBe(200);
    const cantCreateInMine = (
      await send(other, [
        {
          entity: 'entry',
          operation: 'create',
          id: uid(),
          data: { report_id: (await call(me, 'GET', '/reports?period=all&status=all')).json().items[0].id },
        },
      ])
    ).json();
    expect(cantCreateInMine.results[0].status).toBe('error');
    expect((await app.inject({ method: 'GET', url: '/api/v1/sync/changes' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/sync/send', payload: { operations: [] } })).statusCode).toBe(401);
  });

  it('after the account is deleted, sync answers 401 "account_removed" so the phone can clean up', async () => {
    const gone = await registerUser(app, 'gone@example.test');
    expect((await call(gone, 'GET', '/sync/state')).statusCode).toBe(200);
    expect((await call(gone, 'DELETE', '/users/me', { password: 'correct horse' })).statusCode).toBe(204);
    for (const [method, url] of [
      ['GET', '/sync/state'],
      ['GET', '/sync/changes'],
      ['POST', '/sync/send'],
    ] as const) {
      const r = await call(gone, method, url, method === 'POST' ? { operations: [] } : undefined);
      expect(r.statusCode, url).toBe(401);
      expect(r.json().error.code, url).toBe('account_removed');
    }
  });
});

describe('the log itself', () => {
  it('records every kind of write once the migration is in place: create, update and delete', async () => {
    const user = await registerUser(app, 'logger@example.test');
    const before = (await t.pool.query<RowDataPacket[]>('SELECT COALESCE(MAX(seq), 0) AS s FROM mudanca'))[0][0]!.s as number;
    const note = (await call(user, 'POST', '/notes', { title: 'logged' })).json().id;
    await call(user, 'PATCH', `/notes/${note}`, { title: 'logged 2' });
    await call(user, 'DELETE', `/notes/${note}`);
    const [rows] = await t.pool.query<RowDataPacket[]>(
      "SELECT operacao, versao FROM mudanca WHERE usuario_id = ? AND entidade = 'note' AND entidade_id = ? AND seq > ? ORDER BY seq",
      [user.id, note, before],
    );
    expect(rows.map((r) => r.operacao)).toEqual(['upsert', 'upsert', 'excluir']);
    expect(rows[0]!.versao).toBe(1);
    expect(rows[1]!.versao).toBe(2);
    expect(rows[2]!.versao).toBeNull();
  });
});
