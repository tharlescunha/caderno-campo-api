import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestDatabase, registerUser, type TestDatabase, type TestUser } from './helpers.js';

let t: TestDatabase;
let app: FastifyInstance;
let me: TestUser;
let other: TestUser;
let fieldSubject: string;
let roomSubject: string;

beforeAll(async () => {
  t = await createTestDatabase();
  app = createTestApp(t.pool);
  me = await registerUser(app, 'me@example.test');
  other = await registerUser(app, 'other@example.test');
  await call(me, 'POST', '/periods', { name: '5th term', start_date: '2026-08-03' });
  fieldSubject = (
    await call(me, 'POST', '/subjects', { name: 'Phytopathology', weekdays: [2], class_type: 'field', color: 'green' })
  ).json().id;
  roomSubject = (
    await call(me, 'POST', '/subjects', { name: 'Rural Economics', weekdays: [1, 4], class_type: 'classroom', color: 'blue' })
  ).json().id;
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

const call = (user: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: user.headers, ...(payload === undefined ? {} : { payload: payload as object }) });

describe('events', () => {
  let exam: string;

  it('creates an event with defaults', async () => {
    const r = await call(me, 'POST', '/events', {
      type: 'exam',
      title: 'Chapter 3 exam',
      subject_id: roomSubject,
      date: '2026-11-06',
      reminder: '1_day',
      notes: 'chapters 1 to 3',
    });
    expect(r.statusCode).toBe(201);
    exam = r.json().id;
    expect(r.json()).toMatchObject({
      type: 'exam',
      type_description: null,
      subject_id: roomSubject,
      report_id: null,
      date: '2026-11-06',
      reminder: '1_day',
      notes: 'chapters 1 to 3',
      completed: false,
      closed_with_period: false,
    });
    const free = await call(me, 'POST', '/events', { type: 'college_event', title: 'Field day', date: '2026-11-07' });
    expect(free.json()).toMatchObject({ subject_id: null, reminder: 'none' });
  });

  it('type "other" needs a description', async () => {
    const bad = await call(me, 'POST', '/events', { type: 'other', title: 'Trip', date: '2026-11-09' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.fields[0].field).toBe('type_description');
    const ok = await call(me, 'POST', '/events', {
      type: 'other',
      type_description: 'Visit to the cooperative',
      title: 'Trip',
      date: '2026-11-09',
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().type_description).toBe('Visit to the cooperative');
  });

  it('validates required fields and the subject', async () => {
    const r = await call(me, 'POST', '/events', { type: 'party', title: '', date: '6/11' });
    expect(r.statusCode).toBe(422);
    expect(
      r
        .json()
        .error.fields.map((f: { field: string }) => f.field)
        .sort(),
    ).toEqual(['date', 'title', 'type']);
    const nosub = await call(me, 'POST', '/events', { type: 'exam', title: 'X', date: '2026-11-06', subject_id: randomUUID() });
    expect(nosub.statusCode).toBe(422);
  });

  it('PATCH marks completed, changes date and keeps the rest', async () => {
    const r = await call(me, 'PATCH', `/events/${exam}`, { completed: true, date: '2026-11-07' });
    expect(r.json()).toMatchObject({ completed: true, date: '2026-11-07', title: 'Chapter 3 exam' });
    expect(r.json().version).toBeGreaterThan(1);
    const toOther = await call(me, 'PATCH', `/events/${exam}`, { type: 'other' });
    expect(toOther.statusCode).toBe(422);
    const back = await call(me, 'PATCH', `/events/${exam}`, { type: 'other', type_description: 'Make-up class' });
    expect(back.json()).toMatchObject({ type: 'other', type_description: 'Make-up class' });
    const restore = await call(me, 'PATCH', `/events/${exam}`, { type: 'exam' });
    expect(restore.json()).toMatchObject({ type: 'exam', type_description: null });
  });

  it('lists with filters and paging, ordered by date', async () => {
    const all = (await call(me, 'GET', '/events')).json();
    expect(all.total).toBe(3);
    expect(all.items.map((e: { date: string }) => e.date)).toEqual([...all.items.map((e: { date: string }) => e.date)].sort());
    expect((await call(me, 'GET', '/events?type=exam')).json().total).toBe(1);
    expect((await call(me, 'GET', '/events?completed=true')).json().total).toBe(1);
    expect((await call(me, 'GET', `/events?subject_id=${roomSubject}`)).json().total).toBe(1);
    expect((await call(me, 'GET', '/events?start=2026-11-08&end=2026-11-30')).json().total).toBe(1);
    expect((await call(me, 'GET', '/events?limit=2&page=2')).json()).toMatchObject({ page: 2, limit: 2, total: 3 });
  });

  it('events managed by a report cannot be moved or deleted here', async () => {
    const report = randomUUID();
    const event = randomUUID();
    await t.pool.query("INSERT INTO relatorio (id, usuario_id, materia_id, titulo, tipo) VALUES (?, ?, ?, 'Plot', 'continuo')", [
      report,
      me.id,
      fieldSubject,
    ]);
    await t.pool.query(
      "INSERT INTO evento (id, usuario_id, materia_id, relatorio_id, tipo, titulo, data) VALUES (?, ?, ?, ?, 'entrega_relatorio', 'Plot delivery', '2026-11-20')",
      [event, me.id, fieldSubject, report],
    );
    expect((await call(me, 'PATCH', `/events/${event}`, { date: '2026-11-21' })).json().error.code).toBe('managed_by_report');
    expect((await call(me, 'DELETE', `/events/${event}`)).json().error.code).toBe('managed_by_report');
    // but the user can still mark it done and write notes
    expect((await call(me, 'PATCH', `/events/${event}`, { completed: true, notes: 'sent by e-mail' })).json()).toMatchObject({
      completed: true,
      report_id: report,
    });
  });

  it('DELETE removes an event (204) and then it is 404', async () => {
    const created = (await call(me, 'POST', '/events', { type: 'activity', title: 'Temp', date: '2026-12-01' })).json().id;
    expect((await call(me, 'DELETE', `/events/${created}`)).statusCode).toBe(204);
    expect((await call(me, 'GET', `/events/${created}`)).statusCode).toBe(404);
  });
});

describe('agenda', () => {
  const agenda = async (q: string) => (await call(me, 'GET', `/agenda?${q}`)).json();

  it('week with fixed subjects and events (2026-11-02 is a Monday)', async () => {
    const a = await agenda('start=2026-11-02&end=2026-11-08');
    expect(a.days.map((d: { weekday: number }) => d.weekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(a.days[0].subjects.map((s: { name: string }) => s.name)).toEqual(['Rural Economics']);
    expect(a.days[1].subjects.map((s: { name: string }) => s.name)).toEqual(['Phytopathology']);
    expect(a.days[3].subjects).toHaveLength(1);
    expect(a.days[2].subjects).toEqual([]);
    expect(a.days[5].events.map((e: { title: string }) => e.title)).toEqual(['Chapter 3 exam', 'Field day']);
    expect(a.days[5].events[0]).toEqual({
      id: expect.any(String),
      type: 'exam',
      title: 'Chapter 3 exam',
      subject_id: roomSubject,
      completed: true,
    });
  });

  it('chips filter classes and events', async () => {
    const field = await agenda('start=2026-11-02&end=2026-11-08&type=field');
    expect(field.days[0].subjects).toEqual([]);
    expect(field.days[1].subjects).toHaveLength(1);
    expect(field.days[5].events).toEqual([]);
    const exams = await agenda('start=2026-11-02&end=2026-11-08&type=exam');
    expect(exams.days[1].subjects).toEqual([]);
    expect(exams.days[5].events.map((e: { title: string }) => e.title)).toEqual(['Chapter 3 exam']);
    const mixed = await agenda('start=2026-11-02&end=2026-11-08&type=class,other');
    expect(mixed.days[0].subjects).toHaveLength(1);
    expect(mixed.days[5].events.map((e: { title: string }) => e.title)).toEqual(['Field day']);
  });

  it('validates the range (max 42 days, end not before start, known chips)', async () => {
    expect((await call(me, 'GET', '/agenda?start=2026-11-02&end=2026-12-13')).statusCode).toBe(200);
    expect((await call(me, 'GET', '/agenda?start=2026-11-02&end=2026-12-14')).statusCode).toBe(422);
    expect((await call(me, 'GET', '/agenda?start=2026-11-08&end=2026-11-02')).statusCode).toBe(422);
    expect((await call(me, 'GET', '/agenda?start=2026-11-02&end=2026-11-08&type=party')).statusCode).toBe(422);
    expect((await call(me, 'GET', '/agenda')).statusCode).toBe(422);
  });

  it('closing the period hides subjects and future events from the agenda; past ones stay in /events', async () => {
    const closed = await call(me, 'POST', '/periods', { name: '6th term', start_date: '2027-02-01', confirm_closing: true });
    expect(closed.statusCode).toBe(201);
    const a = await agenda('start=2026-11-02&end=2026-11-08');
    // subjects are gone; only the event that has no subject stays
    expect(a.days.every((d: { subjects: unknown[] }) => d.subjects.length === 0)).toBe(true);
    expect(a.days.flatMap((d: { events: { title: string }[] }) => d.events.map((e) => e.title))).toEqual(['Field day']);
    expect((await call(me, 'GET', '/events')).json().total).toBe(2);
    expect((await call(me, 'GET', '/events?include_closed=true')).json().total).toBe(4);
  });

  it('events of a finished period are read-only and cannot be created for its subjects', async () => {
    const [closedEvent] = (await call(me, 'GET', `/events?include_closed=true&subject_id=${roomSubject}`)).json().items;
    expect((await call(me, 'PATCH', `/events/${closedEvent.id}`, { title: 'late' })).json().error.code).toBe('period_finished');
    const r = await call(me, 'POST', '/events', { type: 'exam', title: 'Late', subject_id: roomSubject, date: '2027-03-01' });
    expect(r.statusCode).toBe(409);
  });
});

describe('isolation', () => {
  it('the other account sees nothing and touches nothing', async () => {
    const mine = (await call(me, 'GET', '/events?include_closed=true')).json().items[0].id;
    expect((await call(other, 'GET', '/events?include_closed=true')).json().total).toBe(0);
    for (const [method, url, payload] of [
      ['GET', `/events/${mine}`],
      ['PATCH', `/events/${mine}`, { title: 'hacked' }],
      ['DELETE', `/events/${mine}`],
    ] as const) {
      expect((await call(other, method, url, payload)).statusCode, `${method} ${url}`).toBe(404);
    }
    await call(other, 'POST', '/periods', { name: 'Mine', start_date: '2026-08-03' });
    const stolen = await call(other, 'POST', '/events', { type: 'exam', title: 'X', date: '2026-11-06', subject_id: roomSubject });
    expect(stolen.statusCode).toBe(422);
    const a = (await call(other, 'GET', '/agenda?start=2026-11-02&end=2026-11-08')).json();
    expect(a.days.every((d: { subjects: unknown[]; events: unknown[] }) => d.subjects.length === 0 && d.events.length === 0)).toBe(true);
  });

  it('needs a token', async () => {
    for (const url of ['/events', '/agenda?start=2026-11-02&end=2026-11-08']) {
      expect((await app.inject({ method: 'GET', url: `/api/v1${url}` })).statusCode).toBe(401);
    }
  });
});
