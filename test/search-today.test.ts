import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TranscriptionWorker } from '../src/audios/worker.js';
import { addDays, isoWeekday, localDate } from '../src/lib/time.js';
import { MarketService } from '../src/market/service.js';
import { MediaStorage } from '../src/media/storage.js';
import { FakeNetwork } from './fake-network.js';
import { createTestApp, createTestDatabase, registerUser, type TestDatabase, type TestUser } from './helpers.js';

let t: TestDatabase;
let app: FastifyInstance;
let mediaDir: string;
let me: TestUser;
let other: TestUser;

const call = (user: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: user.headers, ...(payload === undefined ? {} : { payload: payload as object }) });
const find = async (q: string, user = me) => (await call(user, 'GET', `/search?q=${encodeURIComponent(q)}`)).json();
const ids = (hits: { id: string }[]) => hits.map((h) => h.id);

async function uploadAudio(user: TestUser, url: string) {
  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(500, 3)]))], { type: 'audio/ogg' }),
    'v.ogg',
  );
  form.append('duration_s', '12');
  form.append('recorded_at', '2026-11-03T11:20:00Z');
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
  mediaDir = mkdtempSync(join(tmpdir(), 'caderno-home-'));
  const net = new FakeNetwork();
  const market = new MarketService(t.pool, net.fetch, { openWeatherKey: 'k', defaultLatitude: -10.19, defaultLongitude: -48.31 });
  app = createTestApp(t.pool, true, mediaDir, market);
  me = await registerUser(app, 'me@example.test');
  other = await registerUser(app, 'other@example.test');
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

describe('search', () => {
  let subject: string;
  let note: string;
  let report: string;
  let entry: string;
  let event: string;
  let teacher: string;

  beforeAll(async () => {
    await call(me, 'POST', '/periods', { name: '5th term', start_date: '2026-08-03' });
    teacher = (await call(me, 'POST', '/teachers', { name: 'Rita Souza' })).json().id;
    subject = (
      await call(me, 'POST', '/subjects', { name: 'Fitossanidade', weekdays: [2], class_type: 'field', teacher_id: teacher })
    ).json().id;
    note = (
      await call(me, 'POST', '/notes', {
        title: 'Livro da professora',
        text: 'Ler o capítulo sobre manejo integrado de pragas e lagartas.',
        tags: ['leitura'],
        subject_id: subject,
      })
    ).json().id;
    report = (
      await call(me, 'POST', '/reports', {
        title: 'Acompanhamento do milho',
        subject_id: subject,
        type: 'continuous',
        area: { crop: 'milho', place: 'canteiro três' },
        tags: ['lavoura'],
        notes: 'Anotar o estágio em toda visita.',
      })
    ).json().id;
    entry = (
      await call(me, 'POST', `/reports/${report}/entries`, {
        status: 'completed',
        activities: ['application', 'irrigation'],
        application: { product: 'Deltametrina', dose: '200 mL/ha', target: 'lagarta' },
        pest: { found: true, name: 'Lagarta-do-cartucho', level: 'medium' },
        notes: 'Folhas centrais raspadas.',
        stage: 'V6',
        next_visit: ['Conferir se a lagarta diminuiu'],
        tags: ['vistoria'],
      })
    ).json().id;
    event = (
      await call(me, 'POST', '/events', {
        type: 'exam',
        title: 'Prova de Solos',
        date: '2026-12-01',
        notes: 'cobre erosão e adubação',
        subject_id: subject,
      })
    ).json().id;
  });

  it('finds each kind of item and tells which subject it belongs to', async () => {
    const r = await find('lagarta');
    expect(ids(r.notes)).toEqual([note]);
    expect(ids(r.entries)).toEqual([entry]);
    expect(r.reports).toEqual([]);
    expect(r.notes[0]).toMatchObject({ title: 'Livro da professora', subject: { id: subject, name: 'Fitossanidade' } });
    expect(r.entries[0].title).toMatch(/^Acompanhamento do milho · \d{2}\/\d{2}\/\d{4}$/);
    expect(r.entries[0].subject).toMatchObject({ id: subject });
    expect(ids((await find('milho')).reports)).toEqual([report]);
    expect(ids((await find('solos')).events)).toEqual([event]);
    expect(ids((await find('fitossanidade')).subjects)).toEqual([subject]);
  });

  it('ignores accents and capitals, matches the start of words, and needs all the words', async () => {
    expect(ids((await find('ADUBACAO')).events)).toEqual([event]); // "adubação" in the event notes
    expect(ids((await find('aplicacao')).entries)).toEqual([entry]); // activity word "aplicação"
    expect(ids((await find('lag')).notes)).toEqual([note]); // prefix
    expect(ids((await find('manejo pragas')).notes)).toEqual([note]);
    const none = await find('manejo xyzzy');
    expect(Object.values(none).flat()).toEqual([]);
  });

  it('searches tags, products, pest names, the next-visit items, the teacher and the area', async () => {
    expect(ids((await find('leitura')).notes)).toEqual([note]);
    expect(ids((await find('lavoura')).reports)).toEqual([report]);
    expect(ids((await find('vistoria')).entries)).toEqual([entry]);
    expect(ids((await find('deltametrina')).entries)).toEqual([entry]);
    expect(ids((await find('diminuiu')).entries)).toEqual([entry]);
    expect(ids((await find('rita')).subjects)).toEqual([subject]);
    expect(ids((await find('canteiro')).reports)).toEqual([report]);
  });

  it('gives an excerpt around the word found', async () => {
    const hit = (await find('integrado')).notes[0];
    expect(hit.excerpt).toContain('integrado');
    expect(hit.excerpt.length).toBeLessThanOrEqual(150);
  });

  it('follows the changes: edit, rename the teacher, tags and deletes', async () => {
    await call(me, 'PATCH', `/notes/${note}`, { text: 'Agora fala só de irrigação por gotejamento.' });
    expect((await find('lagartas')).notes).toEqual([]);
    expect(ids((await find('gotejamento')).notes)).toEqual([note]);

    await call(me, 'PATCH', `/teachers/${teacher}`, { name: 'Marta Lima' });
    expect((await find('rita')).subjects).toEqual([]);
    expect(ids((await find('marta')).subjects)).toEqual([subject]);

    await call(me, 'PATCH', `/reports/${report}`, { tags: ['irrigado'] });
    expect((await find('lavoura')).reports).toEqual([]);
    expect(ids((await find('irrigado')).reports)).toEqual([report]);

    await call(me, 'PATCH', `/entries/${entry}`, { notes: 'Mudou: encontrei cigarrinha.' });
    expect(ids((await find('cigarrinha')).entries)).toEqual([entry]);
    expect((await find('raspadas')).entries).toEqual([]);

    const todo = (await call(me, 'GET', `/entries/${entry}`)).json().todos[0];
    await call(me, 'DELETE', `/todos/${todo.id}`);
    expect((await find('diminuiu')).entries).toEqual([]);

    await call(me, 'PATCH', `/events/${event}`, { title: 'Prova de Solos II' });
    expect((await find('solos')).events[0].title).toBe('Prova de Solos II');
  });

  it('the delivery event of a report is searchable and goes away with the delivery date', async () => {
    await call(me, 'PATCH', `/reports/${report}`, { delivery_date: '2026-12-20' });
    expect((await find('Entrega do relatório')).events.length).toBe(1);
    await call(me, 'PATCH', `/reports/${report}`, { delivery_date: null });
    expect((await find('Entrega do relatório')).events).toEqual([]);
  });

  it('the text of an audio, once transcribed (or fixed by the user), becomes searchable', async () => {
    const worker = new TranscriptionWorker(t.pool, new MediaStorage(mediaDir), {
      transcribe: async () => ({ text: 'encontrei pulgão nas folhas novas', confidence: 0.9 }),
    });
    const audio = (await uploadAudio(me, `/entries/${entry}/audios`)).json().id;
    expect((await find('pulgão')).entries).toEqual([]); // not transcribed yet
    await worker.runOnce();
    expect(ids((await find('pulgao')).entries)).toEqual([entry]);
    await call(me, 'PATCH', `/audios/${audio}`, { edited_transcription: 'era na verdade percevejo' });
    expect((await find('pulgão')).entries).toEqual([]); // the text the user fixed wins
    expect(ids((await find('percevejo')).entries)).toEqual([entry]);
    await call(me, 'DELETE', `/audios/${audio}`);
    expect((await find('percevejo')).entries).toEqual([]);

    const noteAudio = (await uploadAudio(me, `/notes/${note}/audios`)).json().id;
    await worker.runOnce();
    expect(ids((await find('pulgao')).notes)).toEqual([note]);
    await call(me, 'DELETE', `/audios/${noteAudio}`);
  });

  it('deleting removes from the index: entry, event, note, subject and a whole report', async () => {
    const r2 = (
      await call(me, 'POST', '/reports', {
        title: 'Relatorio efemero',
        subject_id: subject,
        type: 'continuous',
        delivery_date: '2026-12-22',
      })
    ).json().id;
    const e2 = (await call(me, 'POST', `/reports/${r2}/entries`, { notes: 'texto efemero do registro' })).json().id;
    expect(ids((await find('efemero')).reports)).toEqual([r2]);
    expect(ids((await find('efemero')).entries)).toEqual([e2]);
    await call(me, 'DELETE', `/reports/${r2}`);
    const gone = await find('efemero');
    expect(Object.values(gone).flat()).toEqual([]);
    expect((await find('Entrega do relatório')).events).toEqual([]);

    const e3 = (await call(me, 'POST', `/reports/${report}/entries`, { notes: 'registro passageiro' })).json().id;
    await call(me, 'DELETE', `/entries/${e3}`);
    expect((await find('passageiro')).entries).toEqual([]);

    const n3 = (await call(me, 'POST', '/notes', { title: 'Nota passageira' })).json().id;
    expect(ids((await find('passageira')).notes)).toEqual([n3]);
    await call(me, 'DELETE', `/notes/${n3}`);
    expect((await find('passageira')).notes).toEqual([]);

    const s3 = (await call(me, 'POST', '/subjects', { name: 'Disciplina passageira', weekdays: [1] })).json().id;
    expect(ids((await find('disciplina')).subjects)).toEqual([s3]);
    await call(me, 'DELETE', `/subjects/${s3}`);
    expect((await find('disciplina')).subjects).toEqual([]);

    const ev3 = (await call(me, 'POST', '/events', { type: 'activity', title: 'Atividade passageira', date: '2026-12-05' })).json().id;
    expect(ids((await find('passageira')).events)).toEqual([ev3]);
    await call(me, 'DELETE', `/events/${ev3}`);
    expect((await find('passageira')).events).toEqual([]);
  });

  it('copying a subject indexes the copy; a new period keeps old items searchable', async () => {
    await call(me, 'POST', '/periods', { name: '6th term', start_date: '2027-02-01', confirm_closing: true });
    const period = (await call(me, 'GET', '/periods/active')).json().id;
    const copy = (await call(me, 'POST', `/subjects/${subject}/copy`, { period_id: period })).json().id;
    expect(ids((await find('fitossanidade')).subjects).sort()).toEqual([subject, copy].sort());
    expect(ids((await find('milho')).reports)).toEqual([report]); // old period's report is still found
  });

  it('validation, limit of 5 per kind, and isolation', async () => {
    expect((await call(me, 'GET', '/search?q=a')).statusCode).toBe(422);
    expect((await call(me, 'GET', '/search')).statusCode).toBe(422);
    const symbols = await call(me, 'GET', '/search?q=%2B-*()'); // only symbols: no words, so an empty answer, not an error
    expect(symbols.statusCode).toBe(200);
    expect(Object.values(symbols.json()).flat()).toEqual([]);
    for (let i = 0; i < 7; i++) await call(me, 'POST', '/notes', { title: `Muitas notas ${i}` });
    expect((await find('muitas')).notes).toHaveLength(5);

    const secret = (await call(me, 'POST', '/notes', { title: 'Segredo absoluto' })).json().id;
    expect(ids((await find('segredo')).notes)).toEqual([secret]);
    const theirs = await find('segredo', other);
    expect(Object.values(theirs).flat()).toEqual([]);
    expect(Object.values(await find('milho', other)).flat()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/v1/search?q=segredo' })).statusCode).toBe(401);
  });
});

describe('Today', () => {
  let today: string;
  let tomorrow: string;
  let fieldSubject: string;
  let classSubject: string;
  let report: string;

  beforeAll(async () => {
    today = localDate(new Date(), 'America/Araguaina');
    tomorrow = addDays(today, 1);
    await call(other, 'POST', '/periods', { name: 'Other term', start_date: '2026-08-03' });
  });

  it('with no period: empty lists, no active period, the rest still there', async () => {
    const fresh = await registerUser(app, 'fresh@example.test');
    const r = (await call(fresh, 'GET', '/today')).json();
    expect(r).toMatchObject({
      date: today,
      active_period: null,
      subject_today: null,
      subjects_today: [],
      pending: [],
      upcoming_events: [],
      recent_activity: [],
      unread_notifications: 0,
    });
    expect(r.tomorrow).toMatchObject({ date: tomorrow, subject: null, subjects: [], forecast: null });
    expect(r.market.soy.price).toBe(146);
    expect(r.market.dollar.value).toBe(5.4366);
    expect(r.news_of_the_day.id).toMatch(/^\d+$/);
  });

  it('builds the screen: today class, tomorrow field class, pending by urgency, upcoming, recent', async () => {
    const user = await registerUser(app, 'today@example.test');
    const c = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => call(user, method, url, payload);
    const period = (await c('POST', '/periods', { name: '5th term', start_date: '2026-08-03' })).json();
    classSubject = (
      await c('POST', '/subjects', { name: 'Rural Economics', weekdays: [isoWeekday(today)], class_type: 'classroom', color: 'blue' })
    ).json().id;
    fieldSubject = (
      await c('POST', '/subjects', { name: 'Phytopathology', weekdays: [isoWeekday(tomorrow)], class_type: 'field', color: 'green' })
    ).json().id;
    await c('POST', '/notes', { title: 'Class note', subject_id: classSubject });
    await c('POST', '/notes', { title: 'Another', subject_id: classSubject });

    report = (
      await c('POST', '/reports', { title: 'Corn plot', subject_id: fieldSubject, type: 'continuous', delivery_date: addDays(today, 2) })
    ).json().id;
    await c('POST', `/reports/${report}/entries`, { status: 'draft', notes: 'quick draft' });
    const done = (
      await c('POST', `/reports/${report}/entries`, { status: 'completed', next_visit: ['Measure plants', 'Take photos'] })
    ).json().id;
    const exam = (await c('POST', '/events', { type: 'exam', title: 'Study for Soils', date: addDays(today, 3) })).json().id;
    await c('POST', '/events', { type: 'activity', title: 'Far activity', date: addDays(today, 10) });
    await c('POST', '/events', { type: 'exam', title: 'Beyond 14 days', date: addDays(today, 20) });

    const r = (await c('GET', '/today')).json();
    expect(r.active_period).toEqual({ id: period.id, name: '5th term' });
    expect(r.subject_today).toMatchObject({
      id: classSubject,
      name: 'Rural Economics',
      color: 'blue',
      notes_this_class: 2,
      notes_in_subject: 2,
    });
    expect(r.subjects_today.map((s: { id: string }) => s.id)).toEqual([classSubject]);
    expect(r.tomorrow.subject).toMatchObject({ id: fieldSubject, class_type: 'field' });

    // by urgency: delivery, drafts, entries without photos, exams
    expect(r.pending.map((p: { type: string }) => p.type)).toEqual([
      'report_delivery',
      'draft_entry',
      'entry_without_photos',
      'study_for_exam',
    ]);
    expect(r.pending[0]).toMatchObject({
      title: 'Corn plot',
      subject: 'Phytopathology',
      due_date: addDays(today, 2),
      days_left: 2,
      reference: { type: 'report', id: report },
    });
    expect(r.pending[2].reference).toEqual({ type: 'entry', id: done });
    expect(r.pending[3]).toMatchObject({ title: 'Study for Soils', days_left: 3, reference: { type: 'event', id: exam } });

    // up to 5, soonest first: the field class tomorrow comes with the items left open in the report
    const kinds = r.upcoming_events.map((u: { kind: string; date: string }) => `${u.date}:${u.kind}`);
    expect(kinds).toEqual([...kinds].sort());
    expect(r.upcoming_events.length).toBeLessThanOrEqual(5);
    const field = r.upcoming_events.find((u: { kind: string; date: string }) => u.kind === 'field_class' && u.date === tomorrow);
    expect(field).toMatchObject({
      days_left: 1,
      subject: { id: fieldSubject },
      last_visit_todos: { count: 2, texts: ['Measure plants', 'Take photos'] },
    });
    expect(JSON.stringify(r.upcoming_events)).not.toContain('Beyond 14 days');
    expect(r.upcoming_events.some((u: { title?: string }) => u.title === 'Far activity')).toBe(true);

    // recent activity: newest first, at most 5, with kind and action
    expect(r.recent_activity.length).toBeLessThanOrEqual(5);
    expect(r.recent_activity[0]).toMatchObject({
      kind: expect.stringMatching(/entry|note|report/),
      action: expect.stringMatching(/created|updated/),
    });
    const times = r.recent_activity.map((a: { at: string }) => a.at);
    expect(times).toEqual([...times].sort().reverse());

    // market from the cache, and the unread count
    expect(r.market).toMatchObject({
      soy: { price: 146 },
      corn: { price: expect.any(Number) },
      dollar: { value: 5.4366 },
      weather: { temperature_c: 36.61 },
    });
    await t.pool.query(
      "INSERT INTO notificacao (id, usuario_id, tipo, titulo, agendada_para, enviada_em) SELECT UUID(), id, 'lembrete_evento', 'x', NOW(3), NOW(3) FROM usuario WHERE email = 'today@example.test'",
    );
    expect((await c('GET', '/today')).json().unread_notifications).toBe(1);
  });

  it('?date picks another day; lat/lon must come together', async () => {
    const user = (await t.pool.query<RowDataPacket[]>("SELECT id FROM usuario WHERE email = 'today@example.test'"))[0][0]!;
    expect(user.id).toBeTruthy();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'today@example.test', password: 'correct horse' },
    });
    const u: TestUser = { id: user.id, headers: { authorization: `Bearer ${login.json().access_token}` } };
    const nextWeek = (await call(u, 'GET', `/today?date=${addDays(today, 7)}`)).json();
    expect(nextWeek.date).toBe(addDays(today, 7));
    expect(nextWeek.subject_today.id).toBe(classSubject); // same weekday
    expect((await call(u, 'GET', '/today?lat=-10')).statusCode).toBe(422);
    expect((await call(u, 'GET', '/today?date=02-11-2026')).statusCode).toBe(422);
  });

  it('isolation: another account never sees these classes, reports or notes', async () => {
    const r = (await call(other, 'GET', '/today')).json();
    expect(r.active_period.name).toBe('Other term');
    expect(JSON.stringify(r.pending) + JSON.stringify(r.recent_activity) + JSON.stringify(r.upcoming_events)).not.toContain('Corn plot');
    expect(r.recent_activity).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/v1/today' })).statusCode).toBe(401);
  });
});
