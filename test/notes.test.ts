import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestDatabase, registerUser, type TestDatabase, type TestUser } from './helpers.js';

let t: TestDatabase;
let app: FastifyInstance;
let mediaDir: string;
let me: TestUser;
let other: TestUser;
let subject: string;

const call = (user: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: user.headers, ...(payload === undefined ? {} : { payload: payload as object }) });

async function multipart(
  user: TestUser,
  url: string,
  files: { data: Buffer; name?: string; type?: string }[],
  fields: Record<string, string> = {},
) {
  const form = new FormData();
  for (const f of files)
    form.append('file', new Blob([new Uint8Array(f.data)], { type: f.type ?? 'application/octet-stream' }), f.name ?? 'file.bin');
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const response = new Response(form);
  return app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    headers: { ...user.headers, 'content-type': response.headers.get('content-type')! },
    payload: Buffer.from(await response.arrayBuffer()),
  });
}

const png = (w = 300, h = 200) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 80, b: 20 } } })
    .png()
    .toBuffer();
const pdf = () => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(500, 0x20), Buffer.from('\n%%EOF')]);
const ogg = () => Buffer.concat([Buffer.from('OggS'), Buffer.alloc(1000, 5)]);

beforeAll(async () => {
  t = await createTestDatabase();
  mediaDir = mkdtempSync(join(tmpdir(), 'caderno-notes-'));
  app = createTestApp(t.pool, true, mediaDir);
  me = await registerUser(app, 'me@example.test');
  other = await registerUser(app, 'other@example.test');
  await call(me, 'POST', '/periods', { name: '5th term', start_date: '2026-08-03' });
  subject = (await call(me, 'POST', '/subjects', { name: 'Phytopathology', weekdays: [2], class_type: 'field', color: 'green' })).json().id;
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

describe('notes', () => {
  let loose: string;
  let linked: string;

  it('creates a loose note and a note linked to a subject, with tags and a link', async () => {
    const a = await call(me, 'POST', '/notes', { title: 'Idea for the garden', text: 'Try drip irrigation.' });
    expect(a.statusCode).toBe(201);
    loose = a.json().id;
    expect(a.json()).toMatchObject({
      title: 'Idea for the garden',
      text: 'Try drip irrigation.',
      subject: null,
      pinned: false,
      link: null,
      tags: [],
      attachments: [],
      audios: [],
    });

    const b = await call(me, 'POST', '/notes', {
      title: 'Book from the teacher',
      text: 'Read the chapter about integrated pest management.',
      subject_id: subject,
      link: 'https://example.test/book',
      tags: ['leitura', 'pragas'],
      pinned: true,
    });
    expect(b.statusCode).toBe(201);
    linked = b.json().id;
    expect(b.json()).toMatchObject({
      subject: { id: subject, name: 'Phytopathology', color: 'green' },
      link: 'https://example.test/book',
      tags: ['leitura', 'pragas'],
      pinned: true,
    });
  });

  it('validates: title required, link only http/https, own subject', async () => {
    const r = await call(me, 'POST', '/notes', { title: '', link: 'ftp://example.test/x' });
    expect(r.statusCode).toBe(422);
    expect(
      r
        .json()
        .error.fields.map((f: { field: string }) => f.field)
        .sort(),
    ).toEqual(['link', 'title']);
    expect((await call(me, 'POST', '/notes', { title: 'x', link: 'javascript:alert(1)' })).statusCode).toBe(422);
    expect((await call(me, 'POST', '/notes', { title: 'x', subject_id: '3b0c9d3e-6a66-4b6a-9e0e-2f1a9c3c1d11' })).statusCode).toBe(422);
  });

  it('lists pinned first, then the most recently changed, with an excerpt and filters', async () => {
    await call(me, 'POST', '/notes', { title: 'Long one', text: 'word '.repeat(100), tags: ['pragas'] });
    const list = (await call(me, 'GET', '/notes')).json();
    expect(list.total).toBe(3);
    expect(list.items[0].id).toBe(linked); // pinned
    const long = list.items.find((n: { title: string }) => n.title === 'Long one');
    expect(long.excerpt.length).toBeLessThanOrEqual(160);
    expect(long.excerpt.endsWith('…')).toBe(true);
    expect(long).not.toHaveProperty('text'); // the list item is light
    expect((await call(me, 'GET', '/notes?scope=loose')).json().total).toBe(2);
    expect((await call(me, 'GET', '/notes?scope=with_subject')).json().total).toBe(1);
    expect((await call(me, 'GET', `/notes?subject_id=${subject}`)).json().items.map((n: { id: string }) => n.id)).toEqual([linked]);
    expect((await call(me, 'GET', '/notes?tag=pragas')).json().total).toBe(2);
    expect((await call(me, 'GET', '/notes?q=drip')).json().items.map((n: { id: string }) => n.id)).toEqual([loose]);
    expect((await call(me, 'GET', '/notes?q=leitura')).json().total).toBe(1); // by tag
    expect((await call(me, 'GET', '/notes?period=active')).json().total).toBe(1);
    expect((await call(me, 'GET', '/notes?limit=2&page=2')).json()).toMatchObject({ total: 3, page: 2, limit: 2 });
  });

  it('PATCH edits, pins, links and unlinks the subject, replaces tags', async () => {
    const r = await call(me, 'PATCH', `/notes/${loose}`, { pinned: true, subject_id: subject, tags: ['garden'], text: 'Edited.' });
    expect(r.json()).toMatchObject({ pinned: true, subject: { id: subject }, tags: ['garden'], text: 'Edited.' });
    expect(r.json().version).toBeGreaterThan(1);
    const loosened = await call(me, 'PATCH', `/notes/${loose}`, { subject_id: null, pinned: false });
    expect(loosened.json()).toMatchObject({ subject: null, pinned: false, tags: ['garden'] });
    const onlyTags = await call(me, 'PATCH', `/notes/${loose}`, { tags: [] });
    expect(onlyTags.json().tags).toEqual([]);
    expect((await call(me, 'PATCH', `/notes/${loose}`, { link: 'not a link' })).statusCode).toBe(422);
    expect((await call(me, 'PATCH', `/notes/${loose}`, { owner: 'x' })).statusCode).toBe(422);
  });

  it('the subject sees its notes in the counters', async () => {
    const s = (await call(me, 'GET', `/subjects/${subject}`)).json();
    expect(s.totals.notes).toBe(1);
    expect(s.notes[0]).toMatchObject({ id: linked, pinned: true });
  });

  it('DELETE removes the note (204)', async () => {
    const x = (await call(me, 'POST', '/notes', { title: 'Temp' })).json().id;
    expect((await call(me, 'DELETE', `/notes/${x}`)).statusCode).toBe(204);
    expect((await call(me, 'GET', `/notes/${x}`)).statusCode).toBe(404);
  });

  it('notes stay editable after the period ends; moving needs a subject of the active period', async () => {
    await call(me, 'POST', '/periods', { name: '6th term', start_date: '2027-02-01', confirm_closing: true });
    const edited = await call(me, 'PATCH', `/notes/${linked}`, { text: 'Still editable.' });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().subject.id).toBe(subject); // still linked to the old subject
    expect((await call(me, 'GET', '/notes?period=active')).json().total).toBe(0);
    expect((await call(me, 'GET', '/notes')).json().total).toBe(3); // the default shows all periods
    // cannot link a note to the finished period's subject
    const loose2 = (await call(me, 'POST', '/notes', { title: 'Loose' })).json().id;
    const refused = await call(me, 'PATCH', `/notes/${loose2}`, { subject_id: subject });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('period_finished');
    expect((await call(me, 'POST', '/notes', { title: 'New', subject_id: subject })).statusCode).toBe(409);
    // unlinking and relinking inside the same old period is allowed
    expect((await call(me, 'PATCH', `/notes/${linked}`, { subject_id: subject, pinned: false })).statusCode).toBe(200);
    // and to a subject of the new period
    const newSubject = (await call(me, 'POST', '/subjects', { name: 'New subject', weekdays: [1] })).json().id;
    expect((await call(me, 'PATCH', `/notes/${linked}`, { subject_id: newSubject })).json().subject.id).toBe(newSubject);
  });
});

describe('attachments', () => {
  let note: string;
  let photoAttachment: string;
  let pdfAttachment: string;

  beforeAll(async () => {
    note = (await call(me, 'POST', '/notes', { title: 'With files' })).json().id;
  });

  it('accepts a photo and a PDF; the photo gets a thumbnail; files live under the user folder', async () => {
    const r = await multipart(me, `/notes/${note}/attachments`, [
      { data: await png(), name: 'leaf.png' },
      { data: pdf(), name: 'paper.pdf' },
    ]);
    expect(r.statusCode).toBe(201);
    const [photo, doc] = r.json().items;
    photoAttachment = photo.id;
    pdfAttachment = doc.id;
    expect(photo).toMatchObject({ note_id: note, mime_type: 'image/png', thumbnail_url: `/api/v1/attachments/${photo.id}/thumbnail` });
    expect(doc).toMatchObject({ mime_type: 'application/pdf', thumbnail_url: null });
    const [rows] = await t.pool.query<RowDataPacket[]>('SELECT arquivo FROM anexo WHERE id = ?', [photoAttachment]);
    expect(rows[0]?.arquivo).toContain(me.id);
    expect(existsSync(join(mediaDir, rows[0]!.arquivo as string))).toBe(true);
    expect((await call(me, 'GET', `/notes/${note}`)).json().attachments).toHaveLength(2);
  });

  it('serves the files only to the owner, the PDF as a download', async () => {
    const img = await call(me, 'GET', `/attachments/${photoAttachment}`);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['content-disposition']).toBe('inline');
    const doc = await call(me, 'GET', `/attachments/${pdfAttachment}`);
    expect(doc.headers['content-type']).toBe('application/pdf');
    expect(doc.headers['content-disposition']).toBe('attachment');
    expect(doc.headers['x-content-type-options']).toBe('nosniff');
    expect((await call(me, 'GET', `/attachments/${photoAttachment}/thumbnail`)).headers['content-type']).toBe('image/jpeg');
    expect((await call(me, 'GET', `/attachments/${pdfAttachment}/thumbnail`)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/v1/attachments/${photoAttachment}` })).statusCode).toBe(401);
    expect((await call(other, 'GET', `/attachments/${photoAttachment}`)).statusCode).toBe(404);
  });

  it('refuses other types, fake images, big files and more than 20', async () => {
    const url = `/notes/${note}/attachments`;
    expect(
      (await multipart(me, url, [{ data: Buffer.from('MZ\x90\x00 an executable'), name: 'a.pdf', type: 'application/pdf' }])).statusCode,
    ).toBe(422);
    expect((await multipart(me, url, [{ data: Buffer.from('<script>1</script>'), name: 'a.png', type: 'image/png' }])).statusCode).toBe(
      422,
    );
    expect((await multipart(me, url, [])).statusCode).toBe(422);
    expect((await multipart(me, url, [{ data: Buffer.concat([pdf(), Buffer.alloc(10 * 1024 * 1024)]) }])).statusCode).toBe(413);
    const small = pdf();
    expect(
      (
        await multipart(
          me,
          url,
          Array.from({ length: 18 }, () => ({ data: small })),
        )
      ).statusCode,
    ).toBe(201); // 2 + 18 = 20
    expect((await multipart(me, url, [{ data: small }])).statusCode).toBe(422);
  });

  it('an audio can be recorded on a note; the worker-ready rules are the same as in an entry', async () => {
    const r = await multipart(me, `/notes/${note}/audios`, [{ data: ogg(), name: 'voice.ogg', type: 'audio/ogg' }], {
      duration_s: '30',
      recorded_at: '2026-11-03T11:20:00Z',
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ note_id: note, entry_id: null, status: 'transcribing' });
    const n = (await call(me, 'GET', `/notes/${note}`)).json();
    expect(n.audios).toHaveLength(1);
    expect((await call(me, 'PATCH', `/audios/${r.json().id}`, { edited_transcription: 'My text' })).json().edited_transcription).toBe(
      'My text',
    );
    expect((await call(me, 'DELETE', `/audios/${r.json().id}`)).statusCode).toBe(204);
  });

  it('DELETE of an attachment and of the note removes the files', async () => {
    const [row] = (await t.pool.query<RowDataPacket[]>('SELECT arquivo, miniatura FROM anexo WHERE id = ?', [photoAttachment]))[0];
    expect((await call(me, 'DELETE', `/attachments/${photoAttachment}`)).statusCode).toBe(204);
    expect(existsSync(join(mediaDir, row!.arquivo as string))).toBe(false);
    expect(existsSync(join(mediaDir, row!.miniatura as string))).toBe(false);

    const audio = await multipart(me, `/notes/${note}/audios`, [{ data: ogg(), type: 'audio/ogg' }], {
      duration_s: '5',
      recorded_at: '2026-11-03T11:20:00Z',
    });
    const files = (
      await t.pool.query<RowDataPacket[]>(
        'SELECT arquivo FROM anexo WHERE anotacao_id = ? UNION ALL SELECT arquivo FROM audio WHERE anotacao_id = ?',
        [note, note],
      )
    )[0].map((x) => x.arquivo as string);
    expect(files.length).toBe(20);
    expect(files.every((f) => existsSync(join(mediaDir, f)))).toBe(true);
    expect((await call(me, 'DELETE', `/notes/${note}`)).statusCode).toBe(204);
    expect(files.every((f) => !existsSync(join(mediaDir, f)))).toBe(true);
    expect((await call(me, 'GET', `/audios/${audio.json().id}`)).statusCode).toBe(404);
    expect((await t.pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM anexo WHERE anotacao_id = ?', [note]))[0][0]?.n).toBe(0);
  });
});

describe('isolation', () => {
  it('the other account sees and touches nothing of mine', async () => {
    const mine = (await call(me, 'POST', '/notes', { title: 'Private', text: 'secret', tags: ['x'] })).json().id;
    const att = (await multipart(me, `/notes/${mine}/attachments`, [{ data: pdf() }])).json().items[0].id;
    expect((await call(other, 'GET', '/notes')).json().total).toBe(0);
    expect((await call(other, 'GET', '/notes?q=secret')).json().total).toBe(0);
    for (const [method, url, payload] of [
      ['GET', `/notes/${mine}`],
      ['PATCH', `/notes/${mine}`, { title: 'hacked' }],
      ['DELETE', `/notes/${mine}`],
      ['GET', `/attachments/${att}`],
      ['GET', `/attachments/${att}/thumbnail`],
      ['DELETE', `/attachments/${att}`],
    ] as const) {
      expect((await call(other, method, url, payload)).statusCode, `${method} ${url}`).toBe(404);
    }
    expect((await multipart(other, `/notes/${mine}/attachments`, [{ data: pdf() }])).statusCode).toBe(404);
    expect(
      (await multipart(other, `/notes/${mine}/audios`, [{ data: ogg() }], { duration_s: '5', recorded_at: '2026-11-03T11:20:00Z' }))
        .statusCode,
    ).toBe(404);
    // cannot link its own note to my subject, and the tag names are separate per account
    const theirs = (await call(other, 'POST', '/notes', { title: 'Theirs', tags: ['x'] })).json();
    expect((await call(other, 'PATCH', `/notes/${theirs.id}`, { subject_id: subject })).statusCode).toBe(422);
    expect((await call(me, 'GET', `/notes/${mine}`)).json()).toMatchObject({ title: 'Private', text: 'secret' });
    expect((await app.inject({ method: 'GET', url: '/api/v1/notes' })).statusCode).toBe(401);
  });
});
