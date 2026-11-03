import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_ATTEMPTS, TranscriptionWorker } from '../src/audios/worker.js';
import { MediaStorage } from '../src/media/storage.js';
import type { Transcriber } from '../src/transcription/client.js';
import { createTestApp, createTestDatabase, registerUser, type TestDatabase, type TestUser } from './helpers.js';

let t: TestDatabase;
let app: FastifyInstance;
let mediaDir: string;
let me: TestUser;
let other: TestUser;
let entry: string;
let report: string;

/** A transcriber we control: answers, or fails while `failing` is true. */
class FakeTranscriber implements Transcriber {
  failing = false;
  calls: { bytes: number; mime: string; language: string }[] = [];
  async transcribe(audio: Buffer, mime: string, language: string) {
    this.calls.push({ bytes: audio.length, mime, language });
    if (this.failing) throw new Error('tool is down');
    return { text: 'Lagarta nas folhas centrais.', confidence: 0.93 };
  }
}
const fake = new FakeTranscriber();
let worker: TranscriptionWorker;

const call = (user: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: user.headers, ...(payload === undefined ? {} : { payload: payload as object }) });

// the first bytes decide the type: "OggS" is ogg/opus, which is what WhatsApp and many recorders produce
const oggBytes = (extra = 2000) => Buffer.concat([Buffer.from('OggS'), Buffer.alloc(extra, 7)]);
const m4aBytes = () => Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(100)]);

async function upload(user: TestUser, url: string, data: Buffer | null, fields: Record<string, string> = {}) {
  const form = new FormData();
  if (data) form.append('file', new Blob([new Uint8Array(data)], { type: 'audio/ogg' }), 'voice.ogg');
  const defaults: Record<string, string> = { duration_s: '42', recorded_at: '2026-11-03T11:20:00Z' };
  for (const [k, v] of Object.entries({ ...defaults, ...fields })) form.append(k, v);
  const response = new Response(form);
  return app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    headers: { ...user.headers, 'content-type': response.headers.get('content-type')! },
    payload: Buffer.from(await response.arrayBuffer()),
  });
}

const row = async (id: string) => (await t.pool.query<RowDataPacket[]>('SELECT * FROM audio WHERE id = ?', [id]))[0][0]!;

beforeAll(async () => {
  t = await createTestDatabase();
  mediaDir = mkdtempSync(join(tmpdir(), 'caderno-audio-'));
  app = createTestApp(t.pool, true, mediaDir);
  worker = new TranscriptionWorker(t.pool, new MediaStorage(mediaDir), fake);
  me = await registerUser(app, 'me@example.test');
  other = await registerUser(app, 'other@example.test');
  await call(me, 'POST', '/periods', { name: '5th term', start_date: '2026-08-03' });
  const subject = (await call(me, 'POST', '/subjects', { name: 'Phytopathology', weekdays: [2], class_type: 'field' })).json().id;
  report = (await call(me, 'POST', '/reports', { title: 'Corn plot', subject_id: subject, type: 'continuous' })).json().id;
  entry = (await call(me, 'POST', `/reports/${report}/entries`, { notes: 'visit' })).json().id;
});
afterAll(async () => {
  worker.stop();
  await app?.close();
  await t?.drop();
});

describe('upload', () => {
  it('answers 201 at once with status "transcribing" and keeps the file under the user folder', async () => {
    const r = await upload(me, `/entries/${entry}/audios`, oggBytes());
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      entry_id: entry,
      note_id: null,
      duration_s: 42,
      status: 'transcribing',
      language: 'pt-BR',
      transcription: null,
      edited_transcription: null,
      attempts: 0,
      mime_type: 'audio/ogg',
    });
    expect(r.json().url).toBe(`/api/v1/audios/${r.json().id}/file`);
    const saved = await row(r.json().id);
    expect(saved.arquivo).toContain(me.id);
    expect(existsSync(join(mediaDir, saved.arquivo as string))).toBe(true);
    expect(fake.calls).toHaveLength(0); // nothing is transcribed inside the request
  });

  it('refuses what is not audio, bad durations, missing fields and more than 5', async () => {
    const url = `/entries/${entry}/audios`;
    expect((await upload(me, url, Buffer.from('<html>not audio</html>'))).json().error.fields[0].field).toBe('file');
    expect((await upload(me, url, null)).statusCode).toBe(422);
    expect((await upload(me, url, oggBytes(), { duration_s: '301' })).json().error.fields[0].field).toBe('duration_s');
    expect((await upload(me, url, oggBytes(), { duration_s: '0' })).statusCode).toBe(422);
    expect((await upload(me, url, oggBytes(), { recorded_at: 'yesterday' })).json().error.fields[0].field).toBe('recorded_at');
    expect((await upload(me, url, oggBytes(10 * 1024 * 1024))).statusCode).toBe(413);
    expect((await upload(me, url, m4aBytes())).statusCode).toBe(201); // m4a is accepted
    for (let i = 0; i < 3; i++) expect((await upload(me, url, oggBytes())).statusCode).toBe(201);
    const sixth = await upload(me, url, oggBytes());
    expect(sixth.statusCode).toBe(422);
    expect(sixth.json().error.fields[0].message).toContain('5');
  });

  it('accepts the client audio_id (idempotent key) and the repeat is a conflict', async () => {
    const e2 = (await call(me, 'POST', `/reports/${report}/entries`, {})).json().id;
    const id = '8a5f6a0e-1c0d-4c55-a7f6-3b6a6a5d1b11';
    const ok = await upload(me, `/entries/${e2}/audios`, oggBytes(), { audio_id: id });
    expect(ok.json().id).toBe(id);
    expect((await upload(me, `/entries/${e2}/audios`, oggBytes(), { audio_id: id })).statusCode).toBe(409);
  });

  it('the entry lists its audios', async () => {
    expect((await call(me, 'GET', `/entries/${entry}`)).json().audios).toHaveLength(5);
  });
});

describe('transcription worker', () => {
  let audioId: string;

  beforeAll(async () => {
    const e = (await call(me, 'POST', `/reports/${report}/entries`, {})).json().id;
    audioId = (await upload(me, `/entries/${e}/audios`, oggBytes(), { audio_id: '11111111-2222-4333-8444-555555555555' })).json().id;
    // earlier audios of the first entry are left aside so this block is about one job
    await t.pool.query("UPDATE audio SET status = 'pronto' WHERE id <> ?", [audioId]);
  });

  it('transcribes in pt-BR, stores text and confidence, and the entry shows it', async () => {
    expect(await worker.runOnce()).toBe(true);
    expect(fake.calls[0]).toMatchObject({ mime: 'audio/ogg', language: 'pt-BR' });
    const a = (await call(me, 'GET', `/audios/${audioId}`)).json();
    expect(a).toMatchObject({ status: 'ready', transcription: 'Lagarta nas folhas centrais.', confidence: 0.93, error: null, attempts: 1 });
    expect(a.transcribed_at).toMatch(/Z$/);
    expect(await worker.runOnce()).toBe(false); // nothing left
  });

  it('the user text is kept apart and the machine never overwrites it, even on a new transcription', async () => {
    const edited = await call(me, 'PATCH', `/audios/${audioId}`, { edited_transcription: 'Lagarta-do-cartucho nas folhas centrais.' });
    expect(edited.json()).toMatchObject({
      edited_transcription: 'Lagarta-do-cartucho nas folhas centrais.',
      transcription: 'Lagarta nas folhas centrais.',
    });
    const again = await call(me, 'POST', `/audios/${audioId}/retranscribe`);
    expect(again.statusCode).toBe(202);
    expect(again.json()).toMatchObject({ status: 'transcribing', attempts: 0 });
    await worker.runOnce();
    const a = (await call(me, 'GET', `/audios/${audioId}`)).json();
    expect(a).toMatchObject({ status: 'ready', edited_transcription: 'Lagarta-do-cartucho nas folhas centrais.' });
    expect((await call(me, 'PATCH', `/audios/${audioId}`, { edited_transcription: null })).json().edited_transcription).toBeNull();
  });

  it('a failing tool is retried with growing waits, then the audio becomes "error"', async () => {
    const e = (await call(me, 'POST', `/reports/${report}/entries`, {})).json().id;
    const id = (await upload(me, `/entries/${e}/audios`, oggBytes())).json().id;
    fake.failing = true;

    expect(await worker.runOnce()).toBe(true); // attempt 1
    let a = (await call(me, 'GET', `/audios/${id}`)).json();
    expect(a).toMatchObject({ status: 'transcribing', attempts: 1, error: 'tool is down' });
    expect(await worker.runOnce()).toBe(false); // waiting 1 minute

    // pretend the waits passed: 1, 5 and 15 minutes after each failure
    for (const [attempt, minutes] of [
      [2, 1],
      [3, 5],
      [4, 15],
    ] as const) {
      await t.pool.query('UPDATE audio SET atualizado_em = NOW(3) - INTERVAL ? MINUTE, versao = versao + 1 WHERE id = ?', [
        minutes + 1,
        id,
      ]);
      expect(await worker.runOnce()).toBe(true);
      a = (await call(me, 'GET', `/audios/${id}`)).json();
      expect(a.attempts).toBe(attempt);
    }
    expect(MAX_ATTEMPTS).toBe(4);
    expect(a).toMatchObject({ status: 'error', error: 'tool is down' });
    expect(await worker.runOnce()).toBe(false);

    // "Transcribe again" starts over and works once the tool is back
    fake.failing = false;
    await call(me, 'POST', `/audios/${id}/retranscribe`);
    await worker.runOnce();
    expect((await call(me, 'GET', `/audios/${id}`)).json()).toMatchObject({ status: 'ready', error: null });
  });

  it('with "delete the audio after transcribing" the file goes away and the text stays', async () => {
    await call(me, 'PATCH', '/users/me', { delete_audio_after_transcription: true });
    const e = (await call(me, 'POST', `/reports/${report}/entries`, {})).json().id;
    const id = (await upload(me, `/entries/${e}/audios`, oggBytes())).json().id;
    const path = (await row(id)).arquivo as string;
    await worker.runOnce();
    const a = (await call(me, 'GET', `/audios/${id}`)).json();
    expect(a).toMatchObject({ status: 'ready', transcription: 'Lagarta nas folhas centrais.', url: null });
    expect(existsSync(join(mediaDir, path))).toBe(false);
    expect((await call(me, 'GET', `/audios/${id}/file`)).statusCode).toBe(404);
    expect((await call(me, 'POST', `/audios/${id}/retranscribe`)).json().error.code).toBe('audio_file_deleted');
    await call(me, 'PATCH', '/users/me', { delete_audio_after_transcription: false });
  });
});

describe('files, deletion and rules', () => {
  it('serves the audio only to the owner', async () => {
    const e = (await call(me, 'POST', `/reports/${report}/entries`, {})).json().id;
    const fresh = (await upload(me, `/entries/${e}/audios`, oggBytes(300))).json().id;
    const r = await call(me, 'GET', `/audios/${fresh}/file`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('audio/ogg');
    expect(r.rawPayload.length).toBe(304);
    expect((await app.inject({ method: 'GET', url: `/api/v1/audios/${fresh}/file` })).statusCode).toBe(401);
    expect((await call(other, 'GET', `/audios/${fresh}/file`)).statusCode).toBe(404);
  });

  it('DELETE removes the audio and its file; deleting the entry or the report removes the files too', async () => {
    const e = (await call(me, 'POST', `/reports/${report}/entries`, {})).json().id;
    const a = (await upload(me, `/entries/${e}/audios`, oggBytes())).json().id;
    const path = (await row(a)).arquivo as string;
    expect((await call(me, 'DELETE', `/audios/${a}`)).statusCode).toBe(204);
    expect(existsSync(join(mediaDir, path))).toBe(false);

    const b = (await upload(me, `/entries/${e}/audios`, oggBytes())).json().id;
    const bPath = (await row(b)).arquivo as string;
    expect((await call(me, 'DELETE', `/entries/${e}`)).statusCode).toBe(204);
    expect(existsSync(join(mediaDir, bPath))).toBe(false);

    const r2 = (
      await call(me, 'POST', '/reports', {
        title: 'Temp',
        subject_id: (await call(me, 'GET', '/subjects')).json().items[0].id,
        type: 'one_off',
      })
    ).json().id;
    const e2 = (await call(me, 'POST', `/reports/${r2}/entries`, {})).json().id;
    const c = (await upload(me, `/entries/${e2}/audios`, oggBytes())).json().id;
    const cPath = (await row(c)).arquivo as string;
    expect((await call(me, 'DELETE', `/reports/${r2}`)).statusCode).toBe(204);
    expect(existsSync(join(mediaDir, cPath))).toBe(false);
  });

  it('a finished report makes audios read-only', async () => {
    const r = (
      await call(me, 'POST', '/reports', {
        title: 'Lock',
        subject_id: (await call(me, 'GET', '/subjects')).json().items[0].id,
        type: 'continuous',
      })
    ).json().id;
    const e = (await call(me, 'POST', `/reports/${r}/entries`, {})).json().id;
    const a = (await upload(me, `/entries/${e}/audios`, oggBytes())).json().id;
    await call(me, 'POST', `/reports/${r}/finish`);
    expect((await upload(me, `/entries/${e}/audios`, oggBytes())).json().error.code).toBe('report_finished');
    expect((await call(me, 'PATCH', `/audios/${a}`, { edited_transcription: 'x' })).json().error.code).toBe('report_finished');
    expect((await call(me, 'POST', `/audios/${a}/retranscribe`)).json().error.code).toBe('report_finished');
    expect((await call(me, 'DELETE', `/audios/${a}`)).json().error.code).toBe('report_finished');
    expect((await call(me, 'GET', `/audios/${a}`)).statusCode).toBe(200);
  });

  it('isolation: the other account cannot see, change, add or delete', async () => {
    const mine = (await t.pool.query<RowDataPacket[]>('SELECT id, registro_id FROM audio WHERE usuario_id = ? LIMIT 1', [me.id]))[0][0]!;
    for (const [method, url, payload] of [
      ['GET', `/audios/${mine.id}`],
      ['GET', `/audios/${mine.id}/file`],
      ['PATCH', `/audios/${mine.id}`, { edited_transcription: 'hacked' }],
      ['POST', `/audios/${mine.id}/retranscribe`],
      ['DELETE', `/audios/${mine.id}`],
    ] as const) {
      expect((await call(other, method, url, payload)).statusCode, `${method} ${url}`).toBe(404);
    }
    expect((await upload(other, `/entries/${mine.registro_id}/audios`, oggBytes())).statusCode).toBe(404);
    expect((await call(me, 'GET', `/audios/${mine.id}`)).statusCode).toBe(200);
  });
});
