import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestDatabase, registerUser, type TestDatabase, type TestUser } from './helpers.js';

let t: TestDatabase;
let app: FastifyInstance;
let me: TestUser;
let other: TestUser;

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

const call = (user: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: user.headers, ...(payload === undefined ? {} : { payload: payload as object }) });

describe('periods', () => {
  let first: string;
  let second: string;

  it('without an active period: GET /periods/active is 404 and subjects need one (409 no_active_period)', async () => {
    expect((await call(me, 'GET', '/periods/active')).statusCode).toBe(404);
    const r = await call(me, 'POST', '/subjects', { name: 'Soil', weekdays: [1] });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('no_active_period');
    expect((await call(me, 'GET', '/subjects')).json().items).toEqual([]);
  });

  it('creates the first period already active', async () => {
    const r = await call(me, 'POST', '/periods', { name: '5th term', start_date: '2026-08-03' });
    expect(r.statusCode).toBe(201);
    first = r.json().id;
    expect(r.json()).toMatchObject({ status: 'active', end_date: null, totals: { subjects: 0, reports: 0, notes: 0 } });
    expect((await call(me, 'GET', '/periods/active')).json().id).toBe(first);
  });

  it('422 when the end date is before the start date', async () => {
    const r = await call(me, 'POST', '/periods', { name: 'Bad', start_date: '2026-08-03', end_date: '2026-01-01', confirm_closing: true });
    expect(r.statusCode).toBe(422);
  });

  it('a second period needs confirmation and returns the preview', async () => {
    const subject = await call(me, 'POST', '/subjects', { name: 'Phytopathology', weekdays: [2], class_type: 'field' });
    expect(subject.statusCode).toBe(201);
    const subjectId = subject.json().id;

    // data that closing must treat: report in progress, future event, past event, draft entry, note
    const report = randomUUID();
    await t.pool.query("INSERT INTO relatorio (id, usuario_id, materia_id, titulo, tipo) VALUES (?, ?, ?, 'Corn plot', 'continuo')", [
      report,
      me.id,
      subjectId,
    ]);
    await t.pool.query("INSERT INTO registro (id, usuario_id, relatorio_id, data_hora, atividades) VALUES (?, ?, ?, NOW(3), '[]')", [
      randomUUID(),
      me.id,
      report,
    ]);
    const future = randomUUID();
    await t.pool.query(
      "INSERT INTO evento (id, usuario_id, materia_id, tipo, titulo, data) VALUES (?, ?, ?, 'prova', 'Exam', '2099-01-01')",
      [future, me.id, subjectId],
    );
    await t.pool.query(
      "INSERT INTO evento (id, usuario_id, materia_id, tipo, titulo, data) VALUES (?, ?, ?, 'prova', 'Old exam', '2020-01-01')",
      [randomUUID(), me.id, subjectId],
    );
    await t.pool.query("INSERT INTO anotacao (id, usuario_id, materia_id, titulo) VALUES (?, ?, ?, 'Note')", [
      randomUUID(),
      me.id,
      subjectId,
    ]);
    await t.pool.query(
      "INSERT INTO notificacao (id, usuario_id, tipo, titulo, referencia_tipo, referencia_id, agendada_para) VALUES (?, ?, 'lembrete_evento', 'Exam tomorrow', 'evento', ?, '2098-12-31')",
      [randomUUID(), me.id, future],
    );

    const r = await call(me, 'POST', '/periods', { name: '6th term', start_date: '2027-02-02' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('closing_required');
    expect(r.json().error.details).toMatchObject({
      period: { id: first },
      will_close: { subjects: 1, reports_in_progress: 1, future_events: 1 },
      will_keep: { reports: 1, entries: 1, notes: 1 },
    });
    expect(r.json().error.details.warnings[0]).toContain('draft');
    // nothing changed yet
    expect((await call(me, 'GET', '/periods/active')).json().id).toBe(first);

    const preview = await call(me, 'GET', `/periods/${first}/closing-preview`);
    expect(preview.json().will_close).toEqual({ subjects: 1, reports_in_progress: 1, future_events: 1 });
  });

  it('confirming closes the old period in cascade and activates the new one; nothing is deleted', async () => {
    const r = await call(me, 'POST', '/periods', { name: '6th term', start_date: '2027-02-02', confirm_closing: true });
    expect(r.statusCode).toBe(201);
    second = r.json().id;

    const old = (await call(me, 'GET', `/periods/${first}`)).json();
    expect(old.status).toBe('finished');
    expect(old.finished_at).toMatch(/Z$/);
    expect(old.end_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(old.totals).toEqual({ subjects: 1, reports: 1, notes: 1 });
    expect((await call(me, 'GET', '/periods/active')).json().id).toBe(second);

    const [reports] = await t.pool.query<RowDataPacket[]>('SELECT status, finalizado_por FROM relatorio WHERE usuario_id = ?', [me.id]);
    expect(reports).toEqual([expect.objectContaining({ status: 'finalizado', finalizado_por: 'periodo' })]);
    const [events] = await t.pool.query<RowDataPacket[]>(
      'SELECT titulo, encerrado_com_periodo FROM evento WHERE usuario_id = ? ORDER BY data',
      [me.id],
    );
    expect(events.map((e) => [e.titulo, e.encerrado_com_periodo])).toEqual([
      ['Old exam', 0],
      ['Exam', 1],
    ]);
    const [notifications] = await t.pool.query<RowDataPacket[]>('SELECT cancelada_em FROM notificacao WHERE usuario_id = ?', [me.id]);
    expect(notifications[0]?.cancelada_em).not.toBeNull();
    const [drafts] = await t.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM registro WHERE usuario_id = ? AND status = 'rascunho'",
      [me.id],
    );
    expect(drafts[0]?.n).toBe(1);
    const [notes] = await t.pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM anotacao WHERE usuario_id = ?', [me.id]);
    expect(notes[0]?.n).toBe(1);
  });

  it('only one active period is possible', async () => {
    const [active] = await t.pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM periodo WHERE usuario_id = ? AND status = 'ativo'", [
      me.id,
    ]);
    expect(active[0]?.n).toBe(1);
  });

  it('finished periods are read-only: no PATCH and no new subjects', async () => {
    expect((await call(me, 'PATCH', `/periods/${first}`, { name: 'x' })).json().error.code).toBe('period_finished');
    const r = await call(me, 'POST', '/subjects', { period_id: first, name: 'Late', weekdays: [1] });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('period_finished');
    expect((await call(me, 'POST', `/periods/${first}/close`)).json().error.code).toBe('period_finished');
  });

  it('PATCH changes name and dates of the active period', async () => {
    const r = await call(me, 'PATCH', `/periods/${second}`, { name: '6th term (edited)', end_date: '2027-06-30' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ name: '6th term (edited)', end_date: '2027-06-30' });
  });

  it('close without creating another leaves no active period', async () => {
    const r = await call(me, 'POST', `/periods/${second}/close`);
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe('finished');
    expect((await call(me, 'GET', '/periods/active')).statusCode).toBe(404);
  });

  it('lists newest first with paging; DELETE refuses a period with subjects', async () => {
    const list = (await call(me, 'GET', '/periods?limit=1')).json();
    expect(list).toMatchObject({ page: 1, limit: 1, total: 2 });
    expect(list.items[0].id).toBe(second);
    const del = await call(me, 'DELETE', `/periods/${first}`);
    expect(del.statusCode).toBe(409);
    expect(del.json().error.details).toEqual({ subjects: 1 });
    const empty = (await call(me, 'POST', '/periods', { name: 'Empty', start_date: '2027-08-01' })).json();
    expect((await call(me, 'DELETE', `/periods/${empty.id}`)).statusCode).toBe(204);
  });
});

describe('teachers and subjects', () => {
  let teacher: string;
  let subject: string;

  beforeAll(async () => {
    const r = await call(me, 'POST', '/periods', { name: '7th term', start_date: '2027-08-01' });
    expect(r.statusCode).toBe(201);
  });

  it('teacher CRUD', async () => {
    const r = await call(me, 'POST', '/teachers', { name: 'Prof. Ana', email: 'ana@example.test' });
    expect(r.statusCode).toBe(201);
    teacher = r.json().id;
    expect((await call(me, 'PATCH', `/teachers/${teacher}`, { notes: 'Office hours on Monday' })).json()).toMatchObject({
      name: 'Prof. Ana',
      notes: 'Office hours on Monday',
    });
    expect((await call(me, 'POST', '/teachers', { name: '', email: 'bad' })).statusCode).toBe(422);
    expect((await call(me, 'GET', '/teachers')).json().total).toBe(1);
  });

  it('creates a subject in the active period with teacher and weekdays', async () => {
    const r = await call(me, 'POST', '/subjects', {
      name: 'Rural Economics',
      teacher_id: teacher,
      class_type: 'classroom',
      weekdays: [4, 1, 1],
      color: 'blue',
    });
    expect(r.statusCode).toBe(201);
    subject = r.json().id;
    expect(r.json()).toMatchObject({
      name: 'Rural Economics',
      color: 'blue',
      class_type: 'classroom',
      weekdays: [1, 4],
      deactivated: false,
      teacher: { id: teacher, name: 'Prof. Ana' },
      totals: { reports: 0, notes: 0 },
      next_date: null,
    });
  });

  it('validates the subject body', async () => {
    const r = await call(me, 'POST', '/subjects', { name: '', weekdays: [], color: 'pink' });
    expect(r.statusCode).toBe(422);
    expect(
      r
        .json()
        .error.fields.map((f: { field: string }) => f.field)
        .sort(),
    ).toEqual(['color', 'name', 'weekdays']);
  });

  it('shows the next exam and the weekly board (days 1 to 6, Saturday included)', async () => {
    await t.pool.query(
      "INSERT INTO evento (id, usuario_id, materia_id, tipo, titulo, data) VALUES (?, ?, ?, 'prova', 'Exam 6/11', '2099-11-06')",
      [randomUUID(), me.id, subject],
    );
    const detail = (await call(me, 'GET', `/subjects/${subject}`)).json();
    expect(detail.next_date).toEqual({ type: 'exam', date: '2099-11-06', title: 'Exam 6/11' });
    expect(detail.upcoming_events).toHaveLength(1);
    const board = (await call(me, 'GET', '/subjects/weekly-board')).json();
    expect(board.days.map((d: { weekday: number }) => d.weekday)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(board.days[0].subjects[0]).toMatchObject({ id: subject, name: 'Rural Economics', teacher: 'Prof. Ana' });
    expect(board.days[1].subjects).toEqual([]);
  });

  it('PATCH changes fields and weekdays', async () => {
    const r = await call(me, 'PATCH', `/subjects/${subject}`, { name: 'Rural Economics II', weekdays: [6] });
    expect(r.json()).toMatchObject({ name: 'Rural Economics II', weekdays: [6] });
    expect(r.json().version).toBeGreaterThan(1);
  });

  it('deactivate hides it from the board; reactivate brings it back', async () => {
    expect((await call(me, 'POST', `/subjects/${subject}/deactivate`)).json().deactivated).toBe(true);
    expect((await call(me, 'GET', '/subjects/weekly-board')).json().days[5].subjects).toEqual([]);
    expect((await call(me, 'POST', `/subjects/${subject}/reactivate`)).json().deactivated).toBe(false);
    expect((await call(me, 'GET', '/subjects/weekly-board')).json().days[5].subjects).toHaveLength(1);
  });

  it('a teacher in a subject cannot be deleted (409)', async () => {
    const r = await call(me, 'DELETE', `/teachers/${teacher}`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('teacher_in_use');
  });

  it('copy makes a new subject in another active period without reports or notes', async () => {
    const closed = await call(me, 'POST', '/periods', { name: '8th term', start_date: '2028-02-01', confirm_closing: true });
    const copy = await call(me, 'POST', `/subjects/${subject}/copy`, { period_id: closed.json().id });
    expect(copy.statusCode).toBe(201);
    expect(copy.json()).toMatchObject({ name: 'Rural Economics II', weekdays: [6], teacher: { id: teacher }, period_id: closed.json().id });
    expect(copy.json().id).not.toBe(subject);
    // the original now belongs to a finished period: read-only
    expect((await call(me, 'PATCH', `/subjects/${subject}`, { name: 'x' })).json().error.code).toBe('period_finished');
    expect((await call(me, 'POST', `/subjects/${subject}/reactivate`)).statusCode).toBe(409);
    // copying into the finished period is refused
    expect(
      (
        await call(me, 'POST', `/subjects/${copy.json().id}/copy`, {
          period_id: (await call(me, 'GET', '/periods')).json().items.at(-1).id,
        })
      ).statusCode,
    ).toBe(409);
  });

  it('DELETE refuses a subject with linked data and accepts an empty one', async () => {
    const created = (await call(me, 'POST', '/subjects', { name: 'Temporary', weekdays: [3] })).json();
    await t.pool.query("INSERT INTO anotacao (id, usuario_id, materia_id, titulo) VALUES (?, ?, ?, 'N')", [
      randomUUID(),
      me.id,
      created.id,
    ]);
    const refused = await call(me, 'DELETE', `/subjects/${created.id}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: 'subject_has_data', details: { reports: 0, notes: 1, events: 0 } });
    const empty = (await call(me, 'POST', '/subjects', { name: 'Empty', weekdays: [3] })).json();
    expect((await call(me, 'DELETE', `/subjects/${empty.id}`)).statusCode).toBe(204);
    expect((await call(me, 'GET', `/subjects/${empty.id}`)).statusCode).toBe(404);
  });
});

describe('isolation: the other account never sees or touches my data', () => {
  it('lists are empty for the other account', async () => {
    for (const url of ['/periods', '/subjects', '/subjects?period=all', '/teachers']) {
      const r = await call(other, 'GET', url);
      expect(r.statusCode, url).toBe(200);
      expect(r.json().total, url).toBe(0);
    }
    expect((await call(other, 'GET', '/periods/active')).statusCode).toBe(404);
    expect(
      (await call(other, 'GET', '/subjects/weekly-board')).json().days.every((d: { subjects: unknown[] }) => d.subjects.length === 0),
    ).toBe(true);
  });

  it('by-id routes answer 404 (not 403) for someone else’s resources', async () => {
    const period = (await call(me, 'GET', '/periods')).json().items[0].id;
    const subject = (await call(me, 'GET', '/subjects?period=all')).json().items[0].id;
    const teacher = (await call(me, 'GET', '/teachers')).json().items[0].id;
    const attempts: [Parameters<typeof call>[1], string, unknown?][] = [
      ['GET', `/periods/${period}`],
      ['GET', `/periods/${period}/closing-preview`],
      ['PATCH', `/periods/${period}`, { name: 'hacked' }],
      ['POST', `/periods/${period}/close`],
      ['DELETE', `/periods/${period}`],
      ['GET', `/subjects/${subject}`],
      ['PATCH', `/subjects/${subject}`, { name: 'hacked' }],
      ['POST', `/subjects/${subject}/deactivate`],
      ['POST', `/subjects/${subject}/reactivate`],
      ['DELETE', `/subjects/${subject}`],
      ['PATCH', `/teachers/${teacher}`, { name: 'hacked' }],
      ['DELETE', `/teachers/${teacher}`],
    ];
    for (const [method, url, payload] of attempts) {
      const r = await call(other, method, url, payload);
      expect(r.statusCode, `${method} ${url}`).toBe(404);
    }
    // the other account cannot use my teacher in its own subject, nor copy into my period
    await call(other, 'POST', '/periods', { name: 'Mine', start_date: '2026-08-03' });
    const stolen = await call(other, 'POST', '/subjects', { name: 'S', weekdays: [1], teacher_id: teacher });
    expect(stolen.statusCode).toBe(422);
    const mySubject = await call(other, 'POST', '/subjects', { name: 'S', weekdays: [1] });
    expect((await call(other, 'POST', `/subjects/${mySubject.json().id}/copy`, { period_id: period })).statusCode).toBe(404);
    // and nothing of mine changed
    expect((await call(me, 'GET', `/periods/${period}`)).json().name).not.toBe('hacked');
  });

  it('every route needs a token', async () => {
    for (const url of ['/periods', '/periods/active', '/subjects', '/subjects/weekly-board', '/teachers']) {
      expect((await app.inject({ method: 'GET', url: `/api/v1${url}` })).statusCode, url).toBe(401);
    }
  });
});
