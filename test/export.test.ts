import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { unzipSync } from 'fflate';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TranscriptionWorker } from '../src/audios/worker.js';
import { MediaStorage } from '../src/media/storage.js';
import { createTestApp, createTestDatabase, registerUser, type TestDatabase, type TestUser } from './helpers.js';

let t: TestDatabase;
let app: FastifyInstance;
let mediaDir: string;
let me: TestUser;
let other: TestUser;

const call = (user: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: user.headers, ...(payload === undefined ? {} : { payload: payload as object }) });

async function upload(user: TestUser, url: string, files: { data: Buffer; type: string }[], fields: Record<string, string> = {}) {
  const form = new FormData();
  for (const f of files) form.append('file', new Blob([new Uint8Array(f.data)], { type: f.type }), 'file');
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const response = new Response(form);
  return app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    headers: { ...user.headers, 'content-type': response.headers.get('content-type')! },
    payload: Buffer.from(await response.arrayBuffer()),
  });
}
const png = () =>
  sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 120, b: 40 } } })
    .png()
    .toBuffer();
const ogg = () => Buffer.concat([Buffer.from('OggS'), Buffer.alloc(400, 9)]);

beforeAll(async () => {
  t = await createTestDatabase();
  mediaDir = mkdtempSync(join(tmpdir(), 'caderno-export-'));
  app = createTestApp(t.pool, true, mediaDir);
  me = await registerUser(app, 'me@example.test');
  other = await registerUser(app, 'other@example.test');
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

describe('period summary and report export', () => {
  let period: string;
  let report: string;
  let draft: string;
  let first: string;
  let second: string;

  beforeAll(async () => {
    period = (await call(me, 'POST', '/periods', { name: '5º período', start_date: '2026-10-05' })).json().id;
    const teacher = (await call(me, 'POST', '/teachers', { name: 'Profª Rita' })).json().id;
    const subject = (
      await call(me, 'POST', '/subjects', { name: 'Fitossanidade', weekdays: [2], class_type: 'field', teacher_id: teacher })
    ).json().id;
    const soils = (await call(me, 'POST', '/subjects', { name: 'Solos', weekdays: [3] })).json().id;
    report = (
      await call(me, 'POST', '/reports', {
        title: 'Acompanhamento da área de milho',
        subject_id: subject,
        type: 'continuous',
        area: { crop: 'milho', place: 'canteiro 3', length_m: 12, width_m: 10 },
        notes: 'Anotar o estágio em toda visita.',
      })
    ).json().id;
    first = (
      await call(me, 'POST', `/reports/${report}/entries`, {
        recorded_at: '2026-10-06T11:00:00Z', // 08:00 in Palmas
        status: 'completed',
        activities: ['inspection'],
        notes: 'Área demarcada e medida.',
        weather: { origin: 'manual', description: 'sol', temperature_c: 34, humidity_pct: 40, wind_kmh: 10, rain_1h_mm: 0 },
        latitude: -10.2491,
        longitude: -48.3243,
        measurements: { plant_height_cm: 12.5 },
        crop_condition: 'good',
        stage: 'V2',
        irrigation: 'working',
      })
    ).json().id;
    second = (
      await call(me, 'POST', `/reports/${report}/entries`, {
        recorded_at: '2026-10-20T12:30:00Z',
        status: 'completed',
        activities: ['application', 'cleaning'],
        application: { product: 'Deltametrina', dose: '200 mL/ha', target: 'lagarta' },
        pest: { found: true, name: 'Lagarta-do-cartucho', level: 'medium' },
        notes: 'Folhas raspadas; "citação" e; ponto e vírgula.',
        next_visit: ['Conferir se a lagarta diminuiu'],
      })
    ).json().id;
    draft = (
      await call(me, 'POST', `/reports/${report}/entries`, { recorded_at: '2026-10-27T12:00:00Z', status: 'draft', notes: 'rascunho' })
    ).json().id;
    // a second pest/product visit in another subject's report
    const r2 = (await call(me, 'POST', '/reports', { title: 'Solos da área', subject_id: soils, type: 'one_off' })).json().id;
    await call(me, 'POST', `/reports/${r2}/entries`, {
      recorded_at: '2026-10-21T12:00:00Z',
      status: 'completed',
      activities: ['application'],
      application: { product: 'deltametrina', dose: '1' },
      pest: { found: true, name: 'lagarta-do-cartucho', level: 'high' },
    });
    // photos on the first entry, an audio on the second
    await upload(me, `/entries/${first}/photos`, [
      { data: await png(), type: 'image/png' },
      { data: await png(), type: 'image/png' },
    ]);
    await upload(me, `/entries/${second}/audios`, [{ data: ogg(), type: 'audio/ogg' }], {
      duration_s: '10',
      recorded_at: '2026-10-20T12:31:00Z',
    });
    await new TranscriptionWorker(t.pool, new MediaStorage(mediaDir), {
      transcribe: async () => ({ text: 'Encontrei lagartas nas folhas novas.', confidence: 0.9 }),
    }).runOnce();
    await call(me, 'POST', '/notes', { title: 'Nota da matéria', subject_id: subject });
  });

  describe('summary', () => {
    it('totals, crops, pests (grouped without case/accent), products, per subject and per week', async () => {
      const s = (await call(me, 'GET', `/periods/${period}/summary`)).json();
      expect(s.period).toMatchObject({ id: period, name: '5º período', status: 'active' });
      expect(s.totals).toEqual({ visits: 3, reports: 2, crops: 1, photos: 2, notes: 1, subjects: 2 }); // the draft is not a visit
      expect(s.crops).toEqual([
        {
          report_id: report,
          crop: 'milho',
          place: 'canteiro 3',
          area_m2: 120,
          visits: 2,
          first_visit: '2026-10-06',
          last_visit: '2026-10-20',
        },
      ]);
      expect(s.pests).toEqual([{ name: expect.stringMatching(/lagarta-do-cartucho/i), times: 2, max_level: 'high' }]);
      expect(s.products).toEqual([{ name: expect.stringMatching(/deltametrina/i), times: 2 }]);
      expect(s.by_subject).toEqual([
        { subject_id: expect.any(String), name: 'Fitossanidade', reports: 1, entries: 2 },
        { subject_id: expect.any(String), name: 'Solos', reports: 1, entries: 1 },
      ]);
      // weeks start on Monday; empty weeks are there too; the active period goes until today
      expect(s.weeks[0]).toEqual({ start: '2026-10-05', entries: 1 });
      expect(s.weeks[1]).toEqual({ start: '2026-10-12', entries: 0 });
      expect(s.weeks[2]).toEqual({ start: '2026-10-19', entries: 2 });
      expect(s.until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('a finished period goes until its end date, and is still readable', async () => {
      await call(me, 'PATCH', `/periods/${period}`, { end_date: '2026-10-25' });
      await call(me, 'POST', `/periods/${period}/close`);
      const s = (await call(me, 'GET', `/periods/${period}/summary`)).json();
      expect(s.period.status).toBe('finished');
      expect(s.until).toBe('2026-10-25');
      expect(s.weeks.at(-1)).toEqual({ start: '2026-10-19', entries: 2 });
      expect(s.totals.visits).toBe(3);
    });

    it('text and CSV downloads', async () => {
      const text = await call(me, 'GET', `/periods/${period}/summary?format=text`);
      expect(text.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(text.headers['content-disposition']).toContain('attachment; filename="resumo-');
      expect(text.body).toContain('RESUMO DO PERÍODO: 5º período');
      expect(text.body).toContain('Visitas de campo: 3 · Relatórios: 2 · Culturas: 1');
      expect(text.body).toContain('- milho (canteiro 3) · 120 m²: 2 visita(s), de 06/10/2026 a 20/10/2026');
      expect(text.body).toContain('nível máximo alto');
      const csv = await call(me, 'GET', `/periods/${period}/summary?format=csv`);
      expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(csv.body.charCodeAt(0)).toBe(0xfeff);
      expect(csv.body).toContain('secao;nome;quantidade;detalhe');
      expect(csv.body).toContain('totais;visits;3;');
      expect((await call(me, 'GET', `/periods/${period}/summary?format=pdf`)).statusCode).toBe(422);
    });

    it('another period or another account is 404', async () => {
      expect((await call(other, 'GET', `/periods/${period}/summary`)).statusCode).toBe(404);
      expect((await call(me, 'GET', '/periods/3b0c9d3e-6a66-4b6a-9e0e-2f1a9c3c1d11/summary')).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `/api/v1/periods/${period}/summary` })).statusCode).toBe(401);
    });

    it('an empty period gives zeros, not an error', async () => {
      const empty = (await call(other, 'POST', '/periods', { name: 'Vazio', start_date: '2026-10-05' })).json().id;
      const s = (await call(other, 'GET', `/periods/${empty}/summary`)).json();
      expect(s.totals).toEqual({ visits: 0, reports: 0, crops: 0, photos: 0, notes: 0, subjects: 0 });
      expect(s.crops).toEqual([]);
      expect(s.weeks.length).toBeGreaterThan(0);
    });
  });

  describe('report export', () => {
    it('text: header and one block per entry, oldest first, in the user’s time', async () => {
      const r = await call(me, 'GET', `/reports/${report}/export`);
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(r.headers['content-disposition']).toBe('attachment; filename="relatorio-acompanhamento-da-area-de-milho.txt"');
      const body = r.body;
      expect(
        body.startsWith(
          'RELATÓRIO: Acompanhamento da área de milho\nMatéria: Fitossanidade · Profª Rita\nÁrea: milho · canteiro 3 · 12 × 10 m (120 m²)\n',
        ),
      ).toBe(true);
      expect(body).toContain('Orientações: Anotar o estágio em toda visita.');
      const order = [...body.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]);
      expect(order).toEqual(['06/10/2026 08:00', '20/10/2026 09:30', '27/10/2026 09:00']);
      expect(body).toContain('[27/10/2026 09:00] (rascunho)');
      expect(body).toContain('Clima: 34° · sol · umidade 40% · vento 10 km/h · chuva 0 mm');
      expect(body).toContain('Atividades: vistoria');
      expect(body).toContain('Atividades: aplicação, limpeza');
      expect(body).toContain('Aplicação: Deltametrina · 200 mL/ha · alvo: lagarta');
      expect(body).toContain('Medidas: altura das plantas 12,5 cm · estado da cultura boa · estágio V2');
      expect(body).toContain('Irrigação e pragas: irrigação funcionando');
      expect(body).toContain('Irrigação e pragas: praga: Lagarta-do-cartucho (nível médio)');
      expect(body).toContain('Áudio: Encontrei lagartas nas folhas novas.');
      expect(body).toContain('Para a próxima visita: Conferir se a lagarta diminuiu');
      expect(body).toContain('Fotos: 2');
      expect(body).not.toContain('Local:'); // the place is only on request
    });

    it('`include` chooses the parts; `place` adds the coordinates', async () => {
      const r = await call(me, 'GET', `/reports/${report}/export?include=dates,place`);
      expect(r.body).toContain('Local: -10,2491, -48,3243');
      expect(r.body).not.toContain('Clima:');
      expect(r.body).not.toContain('Observações');
      expect(r.body).not.toContain('Fotos:');
      const noDates = await call(me, 'GET', `/reports/${report}/export?include=activities`);
      expect(noDates.body).toContain('[Registro 1]');
      expect((await call(me, 'GET', `/reports/${report}/export?include=secrets`)).statusCode).toBe(422);
    });

    it('`copy=true` answers JSON with the text', async () => {
      const r = await call(me, 'GET', `/reports/${report}/export?copy=true`);
      expect(r.headers['content-type']).toContain('application/json');
      expect(r.json().text).toContain('RELATÓRIO: Acompanhamento da área de milho');
    });

    it('csv: `;`, BOM, one row per entry, quotes escaped, decimal comma', async () => {
      const r = await call(me, 'GET', `/reports/${report}/export?format=csv`);
      expect(r.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(r.body.charCodeAt(0)).toBe(0xfeff);
      const lines = r.body.slice(1).split('\r\n');
      expect(lines[0]).toBe(
        'numero;situacao;data;hora;clima;temperatura_c;umidade_pct;vento_kmh;chuva_mm;atividades;produto;dose;alvo;altura_plantas_cm;area_medida_m2;estado_cultura;estagio;irrigacao;praga;nivel_praga;observacoes;fotos',
      );
      expect(lines[1]).toContain(
        '1;concluido;06/10/2026;08:00;sol;34;40;10;0;vistoria;;;;12,5;;boa;V2;funcionando;;;Observações: Área demarcada e medida.;2',
      );
      expect(lines[2]).toContain(
        '"Observações: Folhas raspadas; ""citação"" e; ponto e vírgula. | Áudio: Encontrei lagartas nas folhas novas. | Para a próxima visita: Conferir se a lagarta diminuiu"',
      );
      expect(lines[3]).toContain('3;rascunho;27/10/2026;09:00');
      expect(lines.filter((l) => l !== '')).toHaveLength(4);
      const some = await call(me, 'GET', `/reports/${report}/export?format=csv&include=dates,photos`);
      expect(some.body.slice(1).split('\r\n')[0]).toBe('numero;situacao;data;hora;fotos');
    });

    it('zip: the text, the CSV, the photos and the audios, named by date and hour', async () => {
      const r = await call(me, 'GET', `/reports/${report}/export?format=zip`);
      expect(r.headers['content-type']).toBe('application/zip');
      const files = unzipSync(new Uint8Array(r.rawPayload));
      expect(Object.keys(files).sort()).toEqual([
        'audios/2026-10-20_0930_1.ogg',
        'fotos/2026-10-06_0800_1.png',
        'fotos/2026-10-06_0800_2.png',
        'relatorio-acompanhamento-da-area-de-milho.csv',
        'relatorio-acompanhamento-da-area-de-milho.txt',
      ]);
      expect(new TextDecoder().decode(files['relatorio-acompanhamento-da-area-de-milho.txt'])).toContain('Fotos: 2');
      expect((await sharp(Buffer.from(files['fotos/2026-10-06_0800_1.png']!)).metadata()).width).toBe(64);
      const noPhotos = unzipSync(new Uint8Array((await call(me, 'GET', `/reports/${report}/export?format=zip&include=dates`)).rawPayload));
      expect(Object.keys(noPhotos).some((f) => f.startsWith('fotos/'))).toBe(false);
    });

    it('a report without entries still exports; finished or old-period reports too', async () => {
      const empty = (await call(other, 'POST', '/periods', { name: 'P', start_date: '2026-10-05' })).json();
      const s = (await call(other, 'POST', '/subjects', { name: 'S', weekdays: [1] })).json().id;
      const r = (await call(other, 'POST', '/reports', { title: 'Vazio', subject_id: s, type: 'one_off' })).json().id;
      const text = (await call(other, 'GET', `/reports/${r}/export`)).body;
      expect(text).toContain('(sem registros ainda)');
      void empty;
      // `me` closed its period above: reading and exporting stay open
      expect((await call(me, 'GET', `/reports/${report}/export`)).statusCode).toBe(200);
    });

    it('isolation', async () => {
      expect((await call(other, 'GET', `/reports/${report}/export`)).statusCode).toBe(404);
      expect((await call(other, 'GET', `/reports/${report}/export?format=zip`)).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `/api/v1/reports/${report}/export` })).statusCode).toBe(401);
    });

    void draft;
  });
});

describe('account export and deletion', () => {
  let user: TestUser;
  let bystander: TestUser;
  let userFolder: string;

  beforeAll(async () => {
    user = await registerUser(app, 'leaving@example.test');
    bystander = await registerUser(app, 'staying@example.test');
    for (const u of [user, bystander]) {
      await call(u, 'POST', '/periods', { name: 'Term', start_date: '2026-08-03' });
      const teacher = (await call(u, 'POST', '/teachers', { name: 'Teacher' })).json().id;
      const subject = (
        await call(u, 'POST', '/subjects', { name: 'Subject', weekdays: [2], class_type: 'field', teacher_id: teacher })
      ).json().id;
      const r = (
        await call(u, 'POST', '/reports', {
          title: 'Report',
          subject_id: subject,
          type: 'continuous',
          delivery_date: '2030-01-10',
          delivery_reminder: '1_day',
          tags: ['x'],
        })
      ).json();
      const e = (await call(u, 'POST', `/reports/${r.id}/entries`, { status: 'completed', next_visit: ['do it'], tags: ['y'] })).json().id;
      await call(u, 'POST', '/events', { type: 'exam', title: 'Exam', date: '2030-02-01', subject_id: subject });
      const n = (await call(u, 'POST', '/notes', { title: 'Note', text: 'text', tags: ['z'], subject_id: subject })).json().id;
      await upload(u, `/entries/${e}/photos`, [{ data: await png(), type: 'image/png' }]);
      await upload(u, `/reports/${r.id}/area-photo`, [{ data: await png(), type: 'image/png' }]);
      await upload(u, `/notes/${n}/attachments`, [{ data: Buffer.from('%PDF-1.4 hello'), type: 'application/pdf' }]);
      await upload(u, `/entries/${e}/audios`, [{ data: ogg(), type: 'audio/ogg' }], {
        duration_s: '5',
        recorded_at: '2026-10-20T12:31:00Z',
      });
    }
    await t.pool.query(
      "INSERT INTO notificacao (id, usuario_id, tipo, titulo, agendada_para, enviada_em) SELECT UUID(), id, 'lembrete_evento', 'x', NOW(3), NOW(3) FROM usuario",
    );
    userFolder = join(mediaDir, user.id);
  });

  it('export: all the account’s rows, without the password hash or tokens', async () => {
    const r = await call(user, 'GET', '/users/me/export');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toContain('attachment; filename="caderno-de-campo-dados.json"');
    const dump = r.json();
    expect(dump).toMatchObject({ format: 'database-rows', version: 1, user: { email: 'leaving@example.test' } });
    expect(JSON.stringify(dump)).not.toContain('senha_hash');
    expect(JSON.stringify(dump)).not.toContain('argon2');
    expect(dump.data.periodo).toHaveLength(1);
    expect(dump.data.materia).toHaveLength(1);
    expect(dump.data.materia_dia).toEqual([expect.objectContaining({ dia_semana: 2 })]);
    expect(dump.data.relatorio).toHaveLength(1);
    expect(dump.data.registro).toHaveLength(1);
    expect(dump.data.registro_pendencia).toHaveLength(1);
    expect(dump.data.evento).toHaveLength(2); // the exam and the report delivery
    expect(dump.data.anotacao).toHaveLength(1);
    expect(dump.data.foto).toHaveLength(2);
    expect(dump.data.anexo).toHaveLength(1);
    expect(dump.data.audio).toHaveLength(1);
    expect(dump.data.tag).toHaveLength(3);
    // nothing of the other account
    expect(JSON.stringify(dump)).not.toContain('staying@example.test');
    expect(dump.data.dispositivo).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/v1/users/me/export' })).statusCode).toBe(401);
  });

  it('delete asks for the right password', async () => {
    expect((await call(user, 'DELETE', '/users/me')).statusCode).toBe(422);
    const wrong = await call(user, 'DELETE', '/users/me', { password: 'wrong wrong' });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().error.fields[0].field).toBe('password');
    expect((await call(user, 'GET', '/users/me')).statusCode).toBe(200); // still there
    expect(existsSync(userFolder)).toBe(true);
  });

  it('delete removes every row of the account, in any table, and the folder of files', async () => {
    const tables = (
      await t.pool.query<RowDataPacket[]>(
        "SELECT table_name AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND column_name = 'usuario_id'",
      )
    )[0].map((r) => r.name as string);
    expect(tables.length).toBeGreaterThan(15);
    const before = (await call(bystander, 'GET', '/users/me/export')).json().data;

    const r = await call(user, 'DELETE', '/users/me', { password: 'correct horse' });
    expect(r.statusCode).toBe(204);

    for (const table of tables) {
      const [rows] = await t.pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table} WHERE usuario_id = ?`, [user.id]);
      expect(rows[0]?.n, table).toBe(0);
    }
    expect((await t.pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM usuario WHERE id = ?', [user.id]))[0][0]?.n).toBe(0);
    const [days] = await t.pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM materia_dia d LEFT JOIN materia m ON m.id = d.materia_id WHERE m.id IS NULL',
    );
    expect(days[0]?.n).toBe(0); // no orphan weekdays
    expect(existsSync(userFolder)).toBe(false);

    // the other account is untouched, rows and files
    const after = (await call(bystander, 'GET', '/users/me/export')).json().data;
    for (const table of Object.keys(before)) expect(after[table].length, table).toBe(before[table].length);
    expect(existsSync(join(mediaDir, bystander.id))).toBe(true);
    const photo = after.foto[0];
    expect((await call(bystander, 'GET', `/photos/${photo.id}`)).statusCode).toBe(200);
  });

  it('the email can be used again, and the old password stops working', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'leaving@example.test', password: 'correct horse' },
    });
    expect(login.statusCode).toBe(401);
    expect(await registerUser(app, 'leaving@example.test')).toBeTruthy();
  });
});
