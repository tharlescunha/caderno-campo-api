import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotificationGenerator } from '../src/notifications/generator.js';
import { createTestApp, createTestDatabase, registerUser, type TestDatabase, type TestUser } from './helpers.js';

// Palmas is UTC-3: 08:00 local = 11:00Z, 18:00 local = 21:00Z.
let t: TestDatabase;
let app: FastifyInstance;
let me: TestUser;
let other: TestUser;
let generator: NotificationGenerator;
let fieldSubject: string;

const call = (user: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: user.headers, ...(payload === undefined ? {} : { payload: payload as object }) });
const at = (iso: string) => new Date(iso);
const inbox = async (user = me) => (await call(user, 'GET', '/notifications')).json();

beforeAll(async () => {
  t = await createTestDatabase();
  app = createTestApp(t.pool);
  generator = new NotificationGenerator(t.pool, undefined);
  me = await registerUser(app, 'me@example.test');
  other = await registerUser(app, 'other@example.test');
  await call(me, 'POST', '/periods', { name: '5th term', start_date: '2026-08-03' });
  // 2026-11-03 is a Tuesday: weekday 2
  fieldSubject = (
    await call(me, 'POST', '/subjects', { name: 'Phytopathology', weekdays: [2], class_type: 'field', remind_eve: false })
  ).json().id;
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

describe('event reminders', () => {
  let exam: string;

  it('an exam with "1 day before" is made shortly before 08:00 local and shows in the inbox once delivered', async () => {
    exam = (await call(me, 'POST', '/events', { type: 'exam', title: 'Chapter 3 exam', date: '2026-11-06', reminder: '1_day' })).json().id;
    expect(await generator.run(at('2026-11-05T09:00:00Z'))).toMatchObject({ created: 0 }); // too early: more than 1 h before
    expect(await generator.run(at('2026-11-05T10:30:00Z'))).toMatchObject({ created: 1, delivered: 0 });
    expect((await inbox()).total).toBe(0); // scheduled, not delivered yet
    expect(await generator.run(at('2026-11-05T11:05:00Z'))).toMatchObject({ created: 0, delivered: 1 });
    const list = await inbox();
    expect(list.total).toBe(1);
    expect(list.unread_count).toBe(1);
    expect(list.items[0]).toMatchObject({
      type: 'event_reminder',
      title: 'Chapter 3 exam',
      text: 'Prova amanhã.',
      reference: { type: 'event', id: exam },
      scheduled_for: '2026-11-05T11:00:00.000Z',
      read_at: null,
    });
    expect(list.items[0].delivered_at).toMatch(/Z$/);
  });

  it('running again never repeats the reminder', async () => {
    expect(await generator.run(at('2026-11-05T11:20:00Z'))).toMatchObject({ created: 0, delivered: 0 });
    expect((await inbox()).total).toBe(1);
  });

  it('a late run still makes it (up to 12 h), a much later one does not', async () => {
    await call(me, 'POST', '/events', { type: 'assignment', title: 'Essay', date: '2026-11-09', reminder: 'on_the_day' }); // due 2026-11-09 11:00Z
    expect((await generator.run(at('2026-11-09T23:30:00Z'))).created).toBe(0); // 12.5 h late
    expect((await generator.run(at('2026-11-09T22:30:00Z'))).created).toBe(1); // 11.5 h late
    expect((await inbox()).items[0]).toMatchObject({ title: 'Essay', text: 'Trabalho hoje.' });
  });

  it('"3 days" says how many days and the date', async () => {
    await call(me, 'POST', '/events', { type: 'exam', title: 'Soils exam', date: '2026-12-10', reminder: '3_days' }); // due 2026-12-07
    await generator.run(at('2026-12-07T11:00:00Z'));
    expect((await inbox()).items[0]).toMatchObject({ title: 'Soils exam', text: 'Prova em 3 dias (10/12).' });
  });

  it('no reminder when the event is done, has none, or the user turned this kind off', async () => {
    const done = (await call(me, 'POST', '/events', { type: 'exam', title: 'Done exam', date: '2027-01-15', reminder: '1_day' })).json().id;
    await call(me, 'PATCH', `/events/${done}`, { completed: true });
    await call(me, 'POST', '/events', { type: 'exam', title: 'No reminder', date: '2027-01-15' });
    expect((await generator.run(at('2027-01-14T11:00:00Z'))).created).toBe(0);

    await call(me, 'POST', '/events', { type: 'exam', title: 'Muted', date: '2027-02-15', reminder: '1_day' });
    await t.pool.query('UPDATE usuario SET aviso_provas_entregas = 0, versao = versao + 1 WHERE id = ?', [me.id]);
    expect((await generator.run(at('2027-02-14T11:00:00Z'))).created).toBe(0);
    await t.pool.query('UPDATE usuario SET aviso_provas_entregas = 1, versao = versao + 1 WHERE id = ?', [me.id]);
  });

  it('an event done after the reminder was made but before delivery is cancelled, not delivered', async () => {
    const id = (await call(me, 'POST', '/events', { type: 'exam', title: 'Quick change', date: '2027-03-11', reminder: '1_day' })).json()
      .id;
    expect((await generator.run(at('2027-03-10T10:30:00Z'))).created).toBe(1);
    await call(me, 'PATCH', `/events/${id}`, { completed: true });
    expect(await generator.run(at('2027-03-10T11:05:00Z'))).toMatchObject({ delivered: 0, cancelled: 1 });
    expect((await inbox()).items.some((n: { title: string }) => n.title === 'Quick change')).toBe(false);
  });

  it('closing the period cancels reminders not yet delivered', async () => {
    await call(me, 'POST', '/events', { type: 'exam', title: 'Will be closed', date: '2099-03-11', reminder: '1_day' });
    expect((await generator.run(at('2099-03-10T10:30:00Z'))).created).toBe(1);
    // an event with a subject belongs to the period: it is closed with it
    await call(me, 'POST', '/events', {
      type: 'exam',
      title: 'Subject exam',
      date: '2099-03-12',
      reminder: '1_day',
      subject_id: fieldSubject,
    });
    expect((await generator.run(at('2099-03-11T10:30:00Z'))).created).toBe(1);
    await call(me, 'POST', '/periods', { name: '6th term', start_date: '2027-02-01', confirm_closing: true });
    const result = await generator.run(at('2099-03-11T11:05:00Z'));
    expect(result.delivered).toBe(0);
    // closing the period already cancelled the unsent reminder of its events
    const [row] = (await t.pool.query<RowDataPacket[]>("SELECT cancelada_em FROM notificacao WHERE titulo = 'Subject exam'"))[0];
    expect(row?.cancelada_em).not.toBeNull();
    const titles = (await inbox()).items.map((n: { title: string }) => n.title);
    expect(titles).not.toContain('Subject exam');
    // new period for the next tests, with the same kind of subject
    fieldSubject = (
      await call(me, 'POST', '/subjects', { name: 'Phytopathology II', weekdays: [2], class_type: 'field', remind_eve: false })
    ).json().id;
  });
});

describe('report delivery reminders', () => {
  it('uses the delivery event and the report; a finished report stops them', async () => {
    const r = (
      await call(me, 'POST', '/reports', {
        title: 'Corn plot',
        subject_id: fieldSubject,
        type: 'continuous',
        delivery_date: '2030-06-10',
        delivery_reminder: '3_days',
      })
    ).json();
    expect((await generator.run(at('2030-06-07T10:30:00Z'))).created).toBe(1); // 07/06 08:00 local = 11:00Z
    await generator.run(at('2030-06-07T11:05:00Z'));
    expect((await inbox()).items.find((n: { type: string }) => n.type === 'delivery_reminder')).toMatchObject({
      type: 'delivery_reminder',
      title: 'Entrega do relatório: Corn plot',
      text: 'Entrega em 3 dias (10/06).',
      reference: { type: 'report', id: r.id },
    });

    const r2 = (
      await call(me, 'POST', '/reports', {
        title: 'Soil sample',
        subject_id: fieldSubject,
        type: 'one_off',
        delivery_date: '2030-07-10',
        delivery_reminder: '1_day',
      })
    ).json();
    expect((await generator.run(at('2030-07-09T10:30:00Z'))).created).toBe(1);
    await call(me, 'POST', `/reports/${r2.id}/finish`);
    expect(await generator.run(at('2030-07-09T11:05:00Z'))).toMatchObject({ delivered: 0, cancelled: 1 });
  });

  it('the user can turn this kind off', async () => {
    await call(me, 'POST', '/reports', {
      title: 'Muted report',
      subject_id: fieldSubject,
      type: 'one_off',
      delivery_date: '2030-08-10',
      delivery_reminder: '1_day',
    });
    await t.pool.query('UPDATE usuario SET aviso_entrega_relatorio = 0, versao = versao + 1 WHERE id = ?', [me.id]);
    expect((await generator.run(at('2030-08-09T11:00:00Z'))).created).toBe(0);
    await t.pool.query('UPDATE usuario SET aviso_entrega_relatorio = 1, versao = versao + 1 WHERE id = ?', [me.id]);
  });
});

describe('field class reminders', () => {
  it('the eve at 18:00 local says it is a field class and lists the items left open in the report', async () => {
    await call(me, 'PATCH', `/subjects/${fieldSubject}`, { remind_eve: true });
    const report = (await call(me, 'POST', '/reports', { title: 'Eve report', subject_id: fieldSubject, type: 'continuous' })).json().id;
    await call(me, 'POST', `/reports/${report}/entries`, {
      status: 'completed',
      next_visit: ['Measure plants', 'Take photos of the leaves'],
    });
    // class on Tuesday 2031-01-07: the eve is Monday 2031-01-06 at 18:00 local = 21:00Z
    expect((await generator.run(at('2031-01-06T19:30:00Z'))).created).toBe(0);
    expect((await generator.run(at('2031-01-06T20:30:00Z'))).created).toBe(1);
    await generator.run(at('2031-01-06T21:05:00Z'));
    const n = (await inbox()).items.find((x: { type: string }) => x.type === 'field_class_reminder');
    expect(n).toMatchObject({ title: 'Amanhã: aula de campo de Phytopathology II', reference: { type: 'subject', id: fieldSubject } });
    expect(n.text).toContain('Amanhã tem aula de campo.');
    expect(n.text).toContain('Itens da última visita: Measure plants; Take photos of the leaves.');
  });

  it('can be turned off by the subject or by the user', async () => {
    await t.pool.query('UPDATE materia SET lembrar_vespera = 0, versao = versao + 1 WHERE id = ?', [fieldSubject]);
    expect((await generator.run(at('2031-01-13T20:30:00Z'))).created).toBe(0);
    await t.pool.query('UPDATE materia SET lembrar_vespera = 1, versao = versao + 1 WHERE id = ?', [fieldSubject]);
    await t.pool.query('UPDATE usuario SET aviso_vespera_campo = 0, versao = versao + 1 WHERE id = ?', [me.id]);
    expect((await generator.run(at('2031-01-13T20:30:00Z'))).created).toBe(0);
    await t.pool.query('UPDATE usuario SET aviso_vespera_campo = 1, versao = versao + 1 WHERE id = ?', [me.id]);
    expect((await generator.run(at('2031-01-13T20:30:00Z'))).created).toBe(1);
  });

  it('classroom-only subjects get no field reminder', async () => {
    await call(me, 'POST', '/subjects', { name: 'Rural Economics', weekdays: [2], class_type: 'classroom' });
    const before = (
      await t.pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM notificacao WHERE titulo LIKE '%Rural Economics%'")
    )[0][0]!.n;
    await generator.run(at('2031-01-20T20:30:00Z'));
    const after = (
      await t.pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM notificacao WHERE titulo LIKE '%Rural Economics%'")
    )[0][0]!.n;
    expect(after).toBe(before);
  });
});

describe('"Have you recorded what you did?" after a field class', () => {
  it('is sent at the chosen time when there is no entry that day, and says so with the subject', async () => {
    const subject = (await call(me, 'POST', '/subjects', { name: 'Field A', weekdays: [3], class_type: 'field', remind_eve: false })).json()
      .id; // Wednesday
    await call(me, 'POST', '/reports', { title: 'Report A', subject_id: subject, type: 'continuous' });
    await call(me, 'POST', '/reports', { title: 'Report B', subject_id: subject, type: 'continuous' });
    // 2032-01-07 is a Wednesday; default time 18:00 local = 21:00Z
    expect((await generator.run(at('2032-01-07T20:30:00Z'))).created).toBeGreaterThanOrEqual(1);
    await generator.run(at('2032-01-07T21:05:00Z'));
    const n = (await inbox()).items.find((x: { title: string }) => x.title === 'Registro de campo: Field A');
    // two reports in progress: points to the subject
    expect(n).toMatchObject({
      type: 'post_field_record_reminder',
      text: 'Hoje foi aula de campo de Field A. Já registrou o que fez?',
      reference: { type: 'subject', id: subject },
    });
  });

  it('points to the report when the subject has just one in progress', async () => {
    const subject = (await call(me, 'POST', '/subjects', { name: 'Field C', weekdays: [4], class_type: 'field', remind_eve: false })).json()
      .id; // Thursday
    const report = (await call(me, 'POST', '/reports', { title: 'Only report', subject_id: subject, type: 'continuous' })).json().id;
    await generator.run(at('2032-01-08T20:30:00Z'));
    await generator.run(at('2032-01-08T21:05:00Z'));
    const n = (await inbox()).items.find((x: { title: string }) => x.title === 'Registro de campo: Field C');
    expect(n.reference).toEqual({ type: 'report', id: report });
  });

  it('is cancelled at delivery time if an entry was recorded that day (local day)', async () => {
    const subject = (await call(me, 'POST', '/subjects', { name: 'Field D', weekdays: [5], class_type: 'field', remind_eve: false })).json()
      .id; // Friday
    const report = (await call(me, 'POST', '/reports', { title: 'Recorded report', subject_id: subject, type: 'continuous' })).json().id;
    expect((await generator.run(at('2032-01-09T20:30:00Z'))).created).toBeGreaterThanOrEqual(1);
    // recorded at 15:00 local (18:00Z) of that Friday, before the reminder time
    await call(me, 'POST', `/reports/${report}/entries`, { recorded_at: '2032-01-09T18:00:00Z' });
    await generator.run(at('2032-01-09T21:05:00Z'));
    expect((await inbox()).items.some((x: { title: string }) => x.title === 'Registro de campo: Field D')).toBe(false);
  });

  it('an entry of another day does not count; the user can turn the reminder off', async () => {
    const subject = (await call(me, 'POST', '/subjects', { name: 'Field E', weekdays: [1], class_type: 'field', remind_eve: false })).json()
      .id; // Monday
    const report = (await call(me, 'POST', '/reports', { title: 'Yesterday report', subject_id: subject, type: 'continuous' })).json().id;
    await call(me, 'POST', `/reports/${report}/entries`, { recorded_at: '2032-01-11T18:00:00Z' }); // Sunday
    await generator.run(at('2032-01-12T20:30:00Z')); // Monday 2032-01-12
    await generator.run(at('2032-01-12T21:05:00Z'));
    expect((await inbox()).items.some((x: { title: string }) => x.title === 'Registro de campo: Field E')).toBe(true);
    await t.pool.query('UPDATE usuario SET lembrar_registro_pos_campo = 0, versao = versao + 1 WHERE id = ?', [me.id]);
    const countAfterField = async () =>
      (await t.pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM notificacao WHERE tipo = 'lembrete_registro_pos_campo'"))[0][0]!.n;
    const before = await countAfterField();
    await generator.run(at('2032-01-19T20:30:00Z')); // next Monday: the eve reminders of Tuesday classes may be made, this kind must not
    expect(await countAfterField()).toBe(before);
    await t.pool.query('UPDATE usuario SET lembrar_registro_pos_campo = 1, versao = versao + 1 WHERE id = ?', [me.id]);
  });

  it('uses the time the user chose', async () => {
    await t.pool.query("UPDATE usuario SET hora_lembrete_pos_campo = '20:30', versao = versao + 1 WHERE id = ?", [me.id]);
    await generator.run(at('2032-01-14T22:45:00Z')); // Wednesday 2032-01-14, 19:45 local: 45 min before 20:30
    const row = (
      await t.pool.query<RowDataPacket[]>(
        "SELECT agendada_para FROM notificacao WHERE tipo = 'lembrete_registro_pos_campo' ORDER BY agendada_para DESC LIMIT 1",
      )
    )[0][0]!;
    expect(new Date(`${(row.agendada_para as string).replace(' ', 'T')}Z`).toISOString()).toBe('2032-01-14T23:30:00.000Z');
    await t.pool.query("UPDATE usuario SET hora_lembrete_pos_campo = '18:00', versao = versao + 1 WHERE id = ?", [me.id]);
  });
});

describe('notes never make a reminder', () => {
  it('creating, pinning and linking notes adds nothing to the inbox', async () => {
    const before = (await t.pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM notificacao'))[0][0]!.n;
    await call(me, 'POST', '/notes', { title: 'A note', text: 'with a date 2040-01-01', pinned: true, subject_id: fieldSubject });
    await generator.run(at('2040-01-01T11:00:00Z'));
    expect((await t.pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM notificacao'))[0][0]!.n).toBe(before);
  });
});

describe('inbox routes', () => {
  it('lists newest first, filters unread, marks one and all as read', async () => {
    const all = await inbox();
    expect(all.total).toBeGreaterThan(3);
    const dates = all.items.map((n: { scheduled_for: string }) => n.scheduled_for);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(all.unread_count).toBe(all.total);

    const first = all.items[0];
    const read = await call(me, 'PATCH', `/notifications/${first.id}/read`);
    expect(read.statusCode).toBe(200);
    expect(read.json().read_at).toMatch(/Z$/);
    const again = await call(me, 'PATCH', `/notifications/${first.id}/read`); // already read: keeps the first time
    expect(again.json().read_at).toBe(read.json().read_at);

    const unread = (await call(me, 'GET', '/notifications?unread=true')).json();
    expect(unread.total).toBe(all.total - 1);
    expect(unread.items.every((n: { read_at: string | null }) => n.read_at === null)).toBe(true);

    const marked = (await call(me, 'POST', '/notifications/read-all')).json();
    expect(marked).toMatchObject({ marked: all.total - 1, unread_count: 0 });
    expect((await inbox()).unread_count).toBe(0);
    expect((await call(me, 'GET', '/notifications?limit=2&page=2')).json()).toMatchObject({ page: 2, limit: 2 });
  });

  it('the Today screen counts the unread ones', async () => {
    await t.pool.query('UPDATE notificacao SET lida_em = NULL WHERE usuario_id = ? LIMIT 2', [me.id]);
    expect((await call(me, 'GET', '/today')).json().unread_notifications).toBe(2);
  });

  it('a cancelled or still scheduled reminder is not in the inbox and cannot be read', async () => {
    const hidden = randomUUID();
    await t.pool.query(
      "INSERT INTO notificacao (id, usuario_id, tipo, titulo, agendada_para) VALUES (?, ?, 'lembrete_evento', 'Future', DATE_ADD(NOW(3), INTERVAL 5 DAY))",
      [hidden, me.id],
    );
    expect((await call(me, 'PATCH', `/notifications/${hidden}/read`)).statusCode).toBe(404);
  });

  it('isolation: the other account has an empty inbox and cannot touch mine', async () => {
    expect((await inbox(other)).total).toBe(0);
    const mine = (await inbox()).items[0].id;
    expect((await call(other, 'PATCH', `/notifications/${mine}/read`)).statusCode).toBe(404);
    expect((await call(other, 'POST', '/notifications/read-all')).json().marked).toBe(0);
    expect((await call(me, 'GET', '/notifications?unread=true')).json().total).toBeGreaterThan(0);
    expect((await app.inject({ method: 'GET', url: '/api/v1/notifications' })).statusCode).toBe(401);
  });
});
