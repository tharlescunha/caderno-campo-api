import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestDatabase, registerUser, type TestDatabase, type TestUser } from './helpers.js';

let t: TestDatabase;
let app: FastifyInstance;
let me: TestUser;
let other: TestUser;
let subject: string;

beforeAll(async () => {
  t = await createTestDatabase();
  app = createTestApp(t.pool);
  me = await registerUser(app, 'me@example.test');
  other = await registerUser(app, 'other@example.test');
  await call(me, 'POST', '/periods', { name: '5th term', start_date: '2026-08-03' });
  subject = (await call(me, 'POST', '/subjects', { name: 'Phytopathology', weekdays: [2], class_type: 'field' })).json().id;
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

const call = (user: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: user.headers, ...(payload === undefined ? {} : { payload: payload as object }) });

describe('reports', () => {
  let corn: string;
  let oneOff: string;

  it('creates a continuous report with area, tags and the delivery event', async () => {
    const r = await call(me, 'POST', '/reports', {
      title: 'Corn plot follow-up',
      subject_id: subject,
      type: 'continuous',
      area: { crop: 'milho', place: 'plot 3', length_m: 12, width_m: 10 },
      delivery_date: '2026-11-05',
      delivery_reminder: '1_day',
      notes: 'Ask for the crop stage every visit.',
      tags: ['milho', 'praga'],
    });
    expect(r.statusCode).toBe(201);
    corn = r.json().id;
    expect(r.json()).toMatchObject({
      title: 'Corn plot follow-up',
      type: 'continuous',
      status: 'in_progress',
      subject: { id: subject, name: 'Phytopathology', color: 'green' },
      area: { crop: 'milho', place: 'plot 3', length_m: 12, width_m: 10, area_m2: 120 },
      delivery_date: '2026-11-05',
      tags: ['milho', 'praga'],
      totals: { entries: 0 },
      last_entry_at: null,
      current_situation: null,
      open_todos: [],
    });
    const events = (await call(me, 'GET', '/events?type=report_delivery')).json();
    expect(events.total).toBe(1);
    expect(events.items[0]).toMatchObject({ report_id: corn, date: '2026-11-05', reminder: '1_day', subject_id: subject });
    expect(r.json().delivery_event_id).toBe(events.items[0].id);
  });

  it('validates the body: area only for continuous, own subject, required fields', async () => {
    const bad = await call(me, 'POST', '/reports', { title: '', subject_id: subject, type: 'one_off' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.fields[0].field).toBe('title');
    const withArea = await call(me, 'POST', '/reports', { title: 'X', subject_id: subject, type: 'one_off', area: { crop: 'x' } });
    expect(withArea.json().error.fields[0].field).toBe('area');
    expect((await call(me, 'POST', '/reports', { title: 'X', subject_id: randomUUID(), type: 'one_off' })).statusCode).toBe(422);
    const one = await call(me, 'POST', '/reports', { title: 'Soil sample', subject_id: subject, type: 'one_off' });
    expect(one.statusCode).toBe(201);
    oneOff = one.json().id;
    expect(one.json().area).toBeNull();
    expect((await call(me, 'GET', '/events?type=report_delivery')).json().total).toBe(1);
  });

  it('PATCH keeps the delivery event in sync (date, title, removal)', async () => {
    const moved = await call(me, 'PATCH', `/reports/${corn}`, { title: 'Corn plot (renamed)', delivery_date: '2026-11-12' });
    expect(moved.json()).toMatchObject({ title: 'Corn plot (renamed)', delivery_date: '2026-11-12' });
    const ev = (await call(me, 'GET', '/events?type=report_delivery')).json().items[0];
    expect(ev).toMatchObject({ date: '2026-11-12' });
    const [rows] = await t.pool.query<RowDataPacket[]>('SELECT titulo FROM evento WHERE relatorio_id = ?', [corn]);
    expect(rows[0]?.titulo).toContain('Corn plot (renamed)');
    // add a delivery to the other report, then remove it
    await call(me, 'PATCH', `/reports/${oneOff}`, { delivery_date: '2026-11-20' });
    expect((await call(me, 'GET', '/events?type=report_delivery')).json().total).toBe(2);
    await call(me, 'PATCH', `/reports/${oneOff}`, { delivery_date: null });
    expect((await call(me, 'GET', '/events?type=report_delivery')).json().total).toBe(1);
    expect((await call(me, 'PATCH', `/reports/${oneOff}`, { area: { crop: 'x' } })).statusCode).toBe(422);
  });

  it('keeps the delivery format (pdf, printed, slides, other) and accepts null', async () => {
    const created = await call(me, 'POST', '/reports', { title: 'Format test', subject_id: subject, type: 'one_off', delivery_format: 'printed' });
    expect(created.statusCode).toBe(201);
    expect(created.json().delivery_format).toBe('printed');
    const id = created.json().id;
    expect((await call(me, 'PATCH', `/reports/${id}`, { delivery_format: 'pdf' })).json().delivery_format).toBe('pdf');
    expect((await call(me, 'PATCH', `/reports/${id}`, { delivery_format: 'word' })).statusCode).toBe(422);
    expect((await call(me, 'PATCH', `/reports/${id}`, { delivery_format: null })).json().delivery_format).toBeNull();
    expect((await call(me, 'GET', `/reports/${id}`)).json().delivery_format).toBeNull();
    expect((await call(me, 'DELETE', `/reports/${id}`)).statusCode).toBe(204); // the other tests count reports
  });

  it('lists in progress by default, with filters and search', async () => {
    const all = (await call(me, 'GET', '/reports')).json();
    expect(all.total).toBe(2);
    expect((await call(me, 'GET', '/reports?type=one_off')).json().total).toBe(1);
    expect((await call(me, 'GET', `/reports?subject_id=${subject}`)).json().total).toBe(2);
    expect((await call(me, 'GET', '/reports?q=praga')).json().items.map((r: { id: string }) => r.id)).toEqual([corn]); // by tag
    expect((await call(me, 'GET', '/reports?q=soil')).json().items.map((r: { id: string }) => r.id)).toEqual([oneOff]); // by title
    expect((await call(me, 'GET', '/reports?q=nothing-here')).json().total).toBe(0);
    expect((await call(me, 'GET', '/reports?status=finished')).json().total).toBe(0);
  });

  it('finish and reopen', async () => {
    await call(me, 'POST', `/reports/${corn}/entries`, { status: 'draft', notes: 'quick draft' });
    const done = await call(me, 'POST', `/reports/${corn}/finish`);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: 'finished', finished_by: 'user', warning: { draft_entries: 1 } });
    expect(done.json().finished_at).toMatch(/Z$/);
    expect((await call(me, 'POST', `/reports/${corn}/finish`)).json().error.code).toBe('report_finished');
    expect((await call(me, 'GET', '/reports')).json().total).toBe(1);
    expect((await call(me, 'GET', '/reports?status=finished')).json().total).toBe(1);
    // finished report: no new entries
    expect((await call(me, 'POST', `/reports/${corn}/entries`, { notes: 'x' })).json().error.code).toBe('report_finished');
    const reopened = await call(me, 'POST', `/reports/${corn}/reopen`);
    expect(reopened.json()).toMatchObject({ status: 'in_progress', finished_at: null, finished_by: null });
    expect((await call(me, 'POST', `/reports/${corn}/reopen`)).json().error.code).toBe('report_not_finished');
  });

  it('DELETE removes the report, its entries, to-do items and the delivery event', async () => {
    const entries = (await call(me, 'GET', `/reports/${corn}/entries`)).json().items;
    expect(entries.length).toBeGreaterThan(0);
    expect((await call(me, 'DELETE', `/reports/${corn}`)).statusCode).toBe(204);
    expect((await call(me, 'GET', `/reports/${corn}`)).statusCode).toBe(404);
    const [events] = await t.pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM evento WHERE relatorio_id = ?', [corn]);
    expect(events[0]?.n).toBe(0);
    const [left] = await t.pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM registro WHERE relatorio_id = ?', [corn]);
    expect(left[0]?.n).toBe(0);
  });
});

describe('entries', () => {
  let report: string;
  let first: string;
  let second: string;
  let todoA: string;

  beforeAll(async () => {
    report = (await call(me, 'POST', '/reports', { title: 'Entries report', subject_id: subject, type: 'continuous' })).json().id;
  });

  it('creates a full entry with application, pest, next-visit items and tags', async () => {
    const r = await call(me, 'POST', `/reports/${report}/entries`, {
      recorded_at: '2026-11-03T11:12:00Z',
      status: 'completed',
      activities: ['inspection', 'cleaning', 'application'],
      application: { product: 'Deltamethrin', dose: '200 mL/ha', target: 'caterpillar' },
      irrigation: 'working',
      measurements: { plant_height_cm: 42, measured_area_m2: 120 },
      crop_condition: 'good',
      stage: 'V6',
      pest: { found: true, name: 'fall armyworm', level: 'medium' },
      notes: 'Central leaves scraped.',
      next_visit: ['Check if the caterpillar decreased', 'Measure plant height again'],
      tags: ['praga', 'vistoria'],
    });
    expect(r.statusCode).toBe(201);
    first = r.json().id;
    expect(r.json()).toMatchObject({
      report_id: report,
      recorded_at: '2026-11-03T11:12:00.000Z',
      status: 'completed',
      activities: ['inspection', 'cleaning', 'application'],
      application: { product: 'Deltamethrin', dose: '200 mL/ha', target: 'caterpillar' },
      irrigation: 'working',
      measurements: { plant_height_cm: 42, measured_area_m2: 120 },
      crop_condition: 'good',
      stage: 'V6',
      pest: { found: true, name: 'fall armyworm', level: 'medium' },
      weather: null,
      weather_origin: null,
      tags: ['praga', 'vistoria'],
    });
    expect(r.json().todos.map((x: { text: string; done: boolean }) => [x.text, x.done])).toEqual([
      ['Check if the caterpillar decreased', false],
      ['Measure plant height again', false],
    ]);
    todoA = r.json().todos[0].id;
  });

  it('report shows the current situation and the open items', async () => {
    const d = (await call(me, 'GET', `/reports/${report}`)).json();
    expect(d.current_situation).toEqual({
      crop_condition: 'good',
      stage: 'V6',
      irrigation: 'working',
      pest: { name: 'fall armyworm', level: 'medium' },
    });
    expect(d.open_todos).toHaveLength(2);
    expect(d.totals.entries).toBe(1);
    expect(d.last_entry_at).toBe('2026-11-03T11:12:00.000Z');
    expect((await call(me, 'GET', '/reports?q=armyworm')).json().total).toBe(1); // search inside entries
  });

  it('rules: pest needs a name, application needs the activity, both coordinates, enums', async () => {
    const url = `/reports/${report}/entries`;
    expect((await call(me, 'POST', url, { pest: { found: true } })).json().error.fields[0].field).toBe('pest.name');
    expect((await call(me, 'POST', url, { activities: ['inspection'], application: { product: 'X' } })).json().error.fields[0].field).toBe(
      'application',
    );
    expect((await call(me, 'POST', url, { latitude: -10.2 })).statusCode).toBe(422);
    expect((await call(me, 'POST', url, { latitude: 95, longitude: 0 })).statusCode).toBe(422);
    expect((await call(me, 'POST', url, { irrigation: 'flooded', next_visit: Array(11).fill('x') })).statusCode).toBe(422);
  });

  it('second visit marks an earlier item done; the report keeps only the open ones', async () => {
    const r = await call(me, 'POST', `/reports/${report}/entries`, {
      recorded_at: '2026-11-10T09:00:00Z',
      status: 'completed',
      todos_done: [todoA],
      next_visit: ['Take photos of the leaves'],
    });
    expect(r.statusCode).toBe(201);
    second = r.json().id;
    const firstNow = (await call(me, 'GET', `/entries/${first}`)).json();
    expect(firstNow.todos[0]).toMatchObject({ id: todoA, done: true, done_in_entry_id: second });
    expect(firstNow.todos[0].done_at).toMatch(/Z$/);
    const open = (await call(me, 'GET', `/reports/${report}/todos`)).json().items;
    expect(open.map((x: { text: string }) => x.text)).toEqual(['Measure plant height again', 'Take photos of the leaves']); // oldest first
    // items must be open items of EARLIER visits of the same report
    expect((await call(me, 'POST', `/reports/${report}/entries`, { todos_done: [todoA] })).statusCode).toBe(422);
    expect((await call(me, 'POST', `/reports/${report}/entries`, { todos_done: [randomUUID()] })).statusCode).toBe(422);
  });

  it('timeline is newest first and paged', async () => {
    const list = (await call(me, 'GET', `/reports/${report}/entries?limit=1`)).json();
    expect(list).toMatchObject({ total: 2, limit: 1 });
    expect(list.items[0].id).toBe(second);
  });

  it('PATCH changes fields, replaces open next-visit items and never touches the weather', async () => {
    const r = await call(me, 'PATCH', `/entries/${second}`, { stage: 'V8', notes: 'Edited', next_visit: ['Only item'], tags: ['x'] });
    expect(r.json()).toMatchObject({ stage: 'V8', notes: 'Edited', tags: ['x'] });
    expect(r.json().todos.map((x: { text: string }) => x.text)).toEqual(['Only item']);
    expect(r.json().version).toBeGreaterThan(1);
    expect((await call(me, 'PATCH', `/entries/${second}`, { weather: { origin: 'manual' } })).statusCode).toBe(422);
    expect((await call(me, 'PATCH', `/entries/${second}`, { latitude: 1, longitude: 2 })).statusCode).toBe(422);
    expect((await call(me, 'PATCH', `/entries/${second}`, { pest: { found: true } })).statusCode).toBe(422);
    // removing the application activity clears the application data
    const cleared = await call(me, 'PATCH', `/entries/${first}`, { activities: ['inspection'] });
    expect(cleared.json().application).toBeNull();
  });

  it('manual weather is stored; coordinates alone become "pending"; both are frozen', async () => {
    const manual = await call(me, 'POST', `/reports/${report}/entries`, {
      weather: { origin: 'manual', description: 'sunny', temperature_c: 36.6, humidity_pct: 39, wind_kmh: 13, rain_1h_mm: 0 },
    });
    expect(manual.json()).toMatchObject({
      weather_origin: 'manual',
      weather: { description: 'sunny', temperature_c: 36.6, humidity_pct: 39, wind_kmh: 13, rain_1h_mm: 0 },
    });
    expect(manual.json().weather.measured_at).toMatch(/Z$/);
    const gps = await call(me, 'POST', `/reports/${report}/entries`, { latitude: -10.2491, longitude: -48.3243 });
    expect(gps.json()).toMatchObject({ latitude: -10.2491, longitude: -48.3243, weather_origin: 'pending', weather: null });
    // editing the entry later leaves the weather alone
    const edited = await call(me, 'PATCH', `/entries/${manual.json().id}`, { notes: 'later note' });
    expect(edited.json().weather).toEqual(manual.json().weather);
  });

  it('to-do items: edit, mark done by hand, reopen, delete', async () => {
    const [item] = (await call(me, 'GET', `/reports/${report}/todos`)).json().items;
    const edited = await call(me, 'PATCH', `/todos/${item.id}`, { text: 'New text', done: true });
    expect(edited.json()).toMatchObject({ text: 'New text', done: true });
    expect((await call(me, 'GET', `/reports/${report}/todos`)).json().items.find((x: { id: string }) => x.id === item.id)).toBeUndefined();
    expect((await call(me, 'PATCH', `/todos/${item.id}`, { done: false })).json()).toMatchObject({ done: false, done_in_entry_id: null });
    expect((await call(me, 'DELETE', `/todos/${item.id}`)).statusCode).toBe(204);
    expect((await call(me, 'PATCH', `/todos/${item.id}`, { done: true })).statusCode).toBe(404);
  });

  it('deleting the entry that closed an item reopens the item', async () => {
    const closer = (await call(me, 'GET', `/entries/${first}`)).json().todos.find((x: { done: boolean }) => x.done);
    expect(closer).toBeDefined();
    expect((await call(me, 'DELETE', `/entries/${second}`)).statusCode).toBe(204);
    const reopened = (await call(me, 'GET', `/entries/${first}`)).json().todos.find((x: { id: string }) => x.id === closer.id);
    expect(reopened).toMatchObject({ done: false, done_in_entry_id: null });
  });

  it('a finished report and a finished period make entries read-only', async () => {
    await call(me, 'POST', `/reports/${report}/finish`);
    expect((await call(me, 'PATCH', `/entries/${first}`, { notes: 'x' })).json().error.code).toBe('report_finished');
    expect((await call(me, 'DELETE', `/entries/${first}`)).json().error.code).toBe('report_finished');
    const todo = (await call(me, 'GET', `/entries/${first}`)).json().todos[0];
    expect((await call(me, 'PATCH', `/todos/${todo.id}`, { text: 'x' })).json().error.code).toBe('report_finished');
    await call(me, 'POST', `/reports/${report}/reopen`);

    const closed = await call(me, 'POST', '/periods', { name: '6th term', start_date: '2027-02-01', confirm_closing: true });
    expect(closed.statusCode).toBe(201);
    const d = (await call(me, 'GET', `/reports/${report}`)).json();
    expect(d).toMatchObject({ status: 'finished', finished_by: 'period' });
    expect((await call(me, 'POST', `/reports/${report}/reopen`)).json().error.code).toBe('period_finished');
    expect((await call(me, 'PATCH', `/reports/${report}`, { title: 'x' })).json().error.code).toBe('period_finished');
    expect((await call(me, 'GET', '/reports')).json().total).toBe(0); // default list = active period
    expect((await call(me, 'GET', '/reports?period=all&status=all')).json().total).toBe(2);
    expect((await call(me, 'POST', '/reports', { title: 'Late', subject_id: subject, type: 'one_off' })).json().error.code).toBe(
      'period_finished',
    );
  });
});

describe('isolation', () => {
  it('the other account sees and changes nothing of mine', async () => {
    const mine = (await call(me, 'GET', '/reports?period=all&status=all')).json().items[0];
    const entry = (await call(me, 'GET', `/reports/${mine.id}/entries`)).json().items[0];
    const todo = (await call(me, 'GET', `/entries/${entry.id}`)).json().todos[0];
    expect((await call(other, 'GET', '/reports?period=all&status=all')).json().total).toBe(0);
    const attempts: [Parameters<typeof call>[1], string, unknown?][] = [
      ['GET', `/reports/${mine.id}`],
      ['PATCH', `/reports/${mine.id}`, { title: 'hacked' }],
      ['DELETE', `/reports/${mine.id}`],
      ['POST', `/reports/${mine.id}/finish`],
      ['POST', `/reports/${mine.id}/reopen`],
      ['GET', `/reports/${mine.id}/entries`],
      ['POST', `/reports/${mine.id}/entries`, { notes: 'x' }],
      ['GET', `/reports/${mine.id}/todos`],
      ['GET', `/entries/${entry.id}`],
      ['PATCH', `/entries/${entry.id}`, { notes: 'hacked' }],
      ['DELETE', `/entries/${entry.id}`],
      ...(todo
        ? ([
            ['PATCH', `/todos/${todo.id}`, { done: true }],
            ['DELETE', `/todos/${todo.id}`],
          ] as [Parameters<typeof call>[1], string, unknown?][])
        : []),
    ];
    for (const [method, url, payload] of attempts) {
      expect((await call(other, method, url, payload)).statusCode, `${method} ${url}`).toBe(404);
    }
    await call(other, 'POST', '/periods', { name: 'Mine', start_date: '2026-08-03' });
    const theirSubject = (await call(other, 'POST', '/subjects', { name: 'S', weekdays: [1] })).json().id;
    const mineReport = await call(other, 'POST', '/reports', { title: 'R', subject_id: theirSubject, type: 'continuous' });
    // cannot use my subject, and cannot mark my to-do items done from its own entries
    expect((await call(other, 'POST', '/reports', { title: 'R', subject_id: subject, type: 'one_off' })).statusCode).toBe(422);
    if (todo) {
      expect((await call(other, 'POST', `/reports/${mineReport.json().id}/entries`, { todos_done: [todo.id] })).statusCode).toBe(422);
    }
    expect((await app.inject({ method: 'GET', url: '/api/v1/reports' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/v1/entries/${entry.id}` })).statusCode).toBe(401);
  });
});
