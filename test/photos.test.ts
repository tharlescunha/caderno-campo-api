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
let report: string;
let entry: string;
let event: string;

const call = (user: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: user.headers, ...(payload === undefined ? {} : { payload: payload as object }) });

async function png(width = 800, height = 600): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 30, g: 140, b: 60 } } })
    .png()
    .toBuffer();
}

/** multipart/form-data body built with the platform FormData. */
async function upload(
  user: TestUser,
  url: string,
  files: { data: Buffer; name?: string; type?: string }[],
  fields: Record<string, string> = {},
) {
  const form = new FormData();
  for (const f of files) form.append('file', new Blob([new Uint8Array(f.data)], { type: f.type ?? 'image/png' }), f.name ?? 'photo.png');
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
  mediaDir = mkdtempSync(join(tmpdir(), 'caderno-photos-'));
  app = createTestApp(t.pool, true, mediaDir);
  me = await registerUser(app, 'me@example.test');
  other = await registerUser(app, 'other@example.test');
  await call(me, 'POST', '/periods', { name: '5th term', start_date: '2026-08-03' });
  subject = (await call(me, 'POST', '/subjects', { name: 'Phytopathology', weekdays: [2], class_type: 'field' })).json().id;
  report = (
    await call(me, 'POST', '/reports', { title: 'Corn plot', subject_id: subject, type: 'continuous', delivery_date: '2026-11-20' })
  ).json().id;
  entry = (await call(me, 'POST', `/reports/${report}/entries`, { notes: 'visit' })).json().id;
  event = (await call(me, 'POST', '/events', { type: 'exam', title: 'Exam', subject_id: subject, date: '2026-12-01' })).json().id;
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

describe('entry photos', () => {
  let photo: { id: string; url: string; thumbnail_url: string };

  it('uploads two images with caption and location, makes thumbnails and stores files per user', async () => {
    const r = await upload(me, `/entries/${entry}/photos`, [{ data: await png() }, { data: await png(100, 50) }], {
      caption: 'Leaf damage',
      taken_at: '2026-11-03T11:15:00Z',
      latitude: '-10.2491',
      longitude: '-48.3243',
    });
    expect(r.statusCode).toBe(201);
    const items = r.json().items;
    expect(items).toHaveLength(2);
    photo = items[0];
    expect(photo).toMatchObject({
      entry_id: entry,
      caption: 'Leaf damage',
      mime_type: 'image/png',
      latitude: -10.2491,
      longitude: -48.3243,
    });
    expect(photo.url).toBe(`/api/v1/photos/${photo.id}`);
    expect(photo.thumbnail_url).toBe(`/api/v1/photos/${photo.id}/thumbnail`);
    const [rows] = await t.pool.query<RowDataPacket[]>('SELECT arquivo, miniatura FROM foto WHERE id = ?', [photo.id]);
    expect(existsSync(join(mediaDir, rows[0]!.arquivo as string))).toBe(true);
    expect(existsSync(join(mediaDir, rows[0]!.miniatura as string))).toBe(true);
    expect(rows[0]!.arquivo).toContain(me.id); // one folder per user
  });

  it('entries list their photos', async () => {
    const e = (await call(me, 'GET', `/entries/${entry}`)).json();
    expect(e.photos).toHaveLength(2);
  });

  it('serves the original and a thumbnail of at most 400 px, only to the owner', async () => {
    const original = await call(me, 'GET', `/photos/${photo.id}`);
    expect(original.statusCode).toBe(200);
    expect(original.headers['content-type']).toBe('image/png');
    expect(original.headers['x-content-type-options']).toBe('nosniff');
    expect((await sharp(original.rawPayload).metadata()).width).toBe(800);
    const thumb = await call(me, 'GET', `/photos/${photo.id}/thumbnail`);
    expect(thumb.headers['content-type']).toBe('image/jpeg');
    const meta = await sharp(thumb.rawPayload).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(400);
    expect((await call(me, 'GET', `/photos/${photo.id}/info`)).json().id).toBe(photo.id);
    expect((await app.inject({ method: 'GET', url: `/api/v1/photos/${photo.id}` })).statusCode).toBe(401);
  });

  it('refuses what is not an image, whatever the name or declared type says', async () => {
    const fake = await upload(me, `/entries/${entry}/photos`, [
      { data: Buffer.from('<script>alert(1)</script>'), name: 'a.jpg', type: 'image/jpeg' },
    ]);
    expect(fake.statusCode).toBe(422);
    expect(fake.json().error.fields[0].field).toBe('file');
    const broken = await upload(me, `/entries/${entry}/photos`, [
      { data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('garbage')]) },
    ]);
    expect(broken.statusCode).toBe(422);
    const empty = await upload(me, `/entries/${entry}/photos`, []);
    expect(empty.statusCode).toBe(422);
    const [count] = await t.pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM foto WHERE registro_id = ?', [entry]);
    expect(count[0]?.n).toBe(2);
  });

  it('refuses files above 10 MB (413) and more than 20 photos', async () => {
    const big = await upload(me, `/entries/${entry}/photos`, [{ data: Buffer.concat([await png(), Buffer.alloc(10 * 1024 * 1024)]) }]);
    expect(big.statusCode).toBe(413);
    const many = await upload(
      me,
      `/entries/${entry}/photos`,
      Array.from({ length: 19 }, () => ({ data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) })),
    );
    expect(many.statusCode).toBe(422); // not valid images, and would exceed 20 anyway
    const image = await png(20, 20);
    const eighteen = await upload(
      me,
      `/entries/${entry}/photos`,
      Array.from({ length: 18 }, () => ({ data: image })),
    );
    expect(eighteen.statusCode).toBe(201);
    const over = await upload(me, `/entries/${entry}/photos`, [{ data: image }]);
    expect(over.statusCode).toBe(422);
    expect(over.json().error.fields[0].message).toContain('20');
  });

  it('accepts a client photo_id for one file, and a repeat is a conflict', async () => {
    const clientId = '3b0c9d3e-6a66-4b6a-9e0e-2f1a9c3c1d11';
    const evEntry = (await call(me, 'POST', `/reports/${report}/entries`, { notes: 'second' })).json().id;
    const ok = await upload(me, `/entries/${evEntry}/photos`, [{ data: await png(50, 50) }], { photo_id: clientId });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().items[0].id).toBe(clientId);
    expect((await upload(me, `/entries/${evEntry}/photos`, [{ data: await png(50, 50) }], { photo_id: clientId })).statusCode).toBe(409);
    expect(
      (await upload(me, `/entries/${evEntry}/photos`, [{ data: await png() }, { data: await png() }], { photo_id: clientId })).statusCode,
    ).toBe(422);
  });

  it('PATCH edits the caption and DELETE removes row and files', async () => {
    expect((await call(me, 'PATCH', `/photos/${photo.id}`, { caption: 'New caption' })).json().caption).toBe('New caption');
    const [rows] = await t.pool.query<RowDataPacket[]>('SELECT arquivo, miniatura FROM foto WHERE id = ?', [photo.id]);
    expect((await call(me, 'DELETE', `/photos/${photo.id}`)).statusCode).toBe(204);
    expect(existsSync(join(mediaDir, rows[0]!.arquivo as string))).toBe(false);
    expect(existsSync(join(mediaDir, rows[0]!.miniatura as string))).toBe(false);
    expect((await call(me, 'GET', `/photos/${photo.id}`)).statusCode).toBe(404);
  });
});

describe('event photos and area photo', () => {
  it('event photos are listed in GET /events/{id} and removed with the event', async () => {
    const r = await upload(me, `/events/${event}/photos`, [{ data: await png() }], { caption: 'Board with the exam content' });
    expect(r.statusCode).toBe(201);
    const files = (await t.pool.query<RowDataPacket[]>('SELECT arquivo FROM foto WHERE evento_id = ?', [event]))[0].map(
      (x) => x.arquivo as string,
    );
    expect((await call(me, 'GET', `/events/${event}`)).json().photos).toHaveLength(1);
    expect((await call(me, 'DELETE', `/events/${event}`)).statusCode).toBe(204);
    expect(files.every((f) => !existsSync(join(mediaDir, f)))).toBe(true);
    expect((await t.pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM foto WHERE evento_id = ?', [event]))[0][0]?.n).toBe(0);
  });

  it('the area photo replaces the previous one and becomes the report cover', async () => {
    const first = await upload(me, `/reports/${report}/area-photo`, [{ data: await png() }]);
    expect(first.statusCode).toBe(201);
    const second = await upload(me, `/reports/${report}/area-photo`, [{ data: await png(300, 300) }]);
    expect(second.statusCode).toBe(201);
    expect((await call(me, 'GET', `/photos/${first.json().id}`)).statusCode).toBe(404);
    const detail = (await call(me, 'GET', `/reports/${report}`)).json();
    expect(detail.area_photo_id).toBe(second.json().id);
    expect(detail.cover_photo).toEqual({ id: second.json().id, thumbnail_url: `/api/v1/photos/${second.json().id}/thumbnail` });
    const one = await call(me, 'POST', '/reports', { title: 'Soil', subject_id: subject, type: 'one_off' });
    expect((await upload(me, `/reports/${one.json().id}/area-photo`, [{ data: await png() }])).statusCode).toBe(422);
  });

  it('without an area photo the cover is the latest entry photo', async () => {
    const r2 = (await call(me, 'POST', '/reports', { title: 'Cover test', subject_id: subject, type: 'continuous' })).json().id;
    expect((await call(me, 'GET', `/reports/${r2}`)).json().cover_photo).toBeNull();
    const e2 = (await call(me, 'POST', `/reports/${r2}/entries`, {})).json().id;
    const p = await upload(me, `/entries/${e2}/photos`, [{ data: await png(60, 60) }]);
    expect((await call(me, 'GET', `/reports/${r2}`)).json().cover_photo.id).toBe(p.json().items[0].id);
  });

  it('the user can choose the cover among the photos of the report, and only of the report', async () => {
    const r3 = (await call(me, 'POST', '/reports', { title: 'Chosen cover', subject_id: subject, type: 'continuous' })).json().id;
    const e3 = (await call(me, 'POST', `/reports/${r3}/entries`, {})).json().id;
    const first = (await upload(me, `/entries/${e3}/photos`, [{ data: await png(60, 60) }])).json().items[0].id;
    await upload(me, `/entries/${e3}/photos`, [{ data: await png(70, 70) }]); // the latest one is the default cover
    const choose = await call(me, 'PATCH', `/reports/${r3}`, { cover_photo_id: first });
    expect(choose.statusCode).toBe(200);
    expect(choose.json().chosen_cover_photo_id).toBe(first);
    expect(choose.json().cover_photo.id).toBe(first);
    // a photo of another report is refused
    const other = (await call(me, 'POST', '/reports', { title: 'Other', subject_id: subject, type: 'continuous' })).json().id;
    const eo = (await call(me, 'POST', `/reports/${other}/entries`, {})).json().id;
    const foreign = (await upload(me, `/entries/${eo}/photos`, [{ data: await png(60, 60) }])).json().items[0].id;
    expect((await call(me, 'PATCH', `/reports/${r3}`, { cover_photo_id: foreign })).statusCode).toBe(422);
    // deleting the chosen photo goes back to the default cover
    expect((await call(me, 'DELETE', `/photos/${first}`)).statusCode).toBe(204);
    const after = (await call(me, 'GET', `/reports/${r3}`)).json();
    expect(after.chosen_cover_photo_id).toBeNull();
    expect(after.cover_photo).not.toBeNull();
    // removing the choice
    expect((await call(me, 'PATCH', `/reports/${r3}`, { cover_photo_id: null })).statusCode).toBe(200);
  });

  it('deleting an entry or a report deletes their files', async () => {
    const r3 = (
      await call(me, 'POST', '/reports', { title: 'To delete', subject_id: subject, type: 'continuous', delivery_date: '2026-12-10' })
    ).json();
    const e3 = (await call(me, 'POST', `/reports/${r3.id}/entries`, {})).json().id;
    await upload(me, `/entries/${e3}/photos`, [{ data: await png(40, 40) }]);
    await upload(me, `/reports/${r3.id}/area-photo`, [{ data: await png(40, 40) }]);
    await upload(me, `/events/${r3.delivery_event_id}/photos`, [{ data: await png(40, 40) }]);
    const files = (
      await t.pool.query<RowDataPacket[]>(
        'SELECT arquivo, miniatura FROM foto WHERE relatorio_id = ? OR registro_id = ? OR evento_id = ?',
        [r3.id, e3, r3.delivery_event_id],
      )
    )[0].flatMap((x) => [x.arquivo as string, x.miniatura as string]);
    expect(files).toHaveLength(6);
    expect(files.every((f) => existsSync(join(mediaDir, f)))).toBe(true);
    expect((await call(me, 'DELETE', `/reports/${r3.id}`)).statusCode).toBe(204);
    expect(files.every((f) => !existsSync(join(mediaDir, f)))).toBe(true);
    expect((await t.pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM foto WHERE usuario_id = ?', [me.id]))[0][0]?.n).toBeGreaterThan(
      0,
    ); // other photos stay
  });

  it('removing the delivery date of a report removes the event photos too', async () => {
    const r4 = (
      await call(me, 'POST', '/reports', { title: 'Delivery', subject_id: subject, type: 'one_off', delivery_date: '2026-12-12' })
    ).json();
    const up = await upload(me, `/events/${r4.delivery_event_id}/photos`, [{ data: await png(40, 40) }]);
    const [row] = (await t.pool.query<RowDataPacket[]>('SELECT arquivo FROM foto WHERE id = ?', [up.json().items[0].id]))[0];
    await call(me, 'PATCH', `/reports/${r4.id}`, { delivery_date: null });
    expect(existsSync(join(mediaDir, row!.arquivo as string))).toBe(false);
  });
});

describe('read-only rules and isolation', () => {
  it('finished report and finished period block photo changes', async () => {
    const r = (await call(me, 'POST', '/reports', { title: 'Lock', subject_id: subject, type: 'continuous' })).json().id;
    const e = (await call(me, 'POST', `/reports/${r}/entries`, {})).json().id;
    const p = (await upload(me, `/entries/${e}/photos`, [{ data: await png(40, 40) }])).json().items[0].id;
    await call(me, 'POST', `/reports/${r}/finish`);
    expect((await upload(me, `/entries/${e}/photos`, [{ data: await png(40, 40) }])).json().error.code).toBe('report_finished');
    expect((await call(me, 'PATCH', `/photos/${p}`, { caption: 'x' })).json().error.code).toBe('report_finished');
    expect((await call(me, 'DELETE', `/photos/${p}`)).json().error.code).toBe('report_finished');
    expect((await call(me, 'GET', `/photos/${p}`)).statusCode).toBe(200); // reading stays open
  });

  it('the other account cannot see, change or add photos to my things', async () => {
    const mine = (
      await t.pool.query<RowDataPacket[]>('SELECT id, registro_id FROM foto WHERE usuario_id = ? AND registro_id IS NOT NULL LIMIT 1', [
        me.id,
      ])
    )[0][0]!;
    for (const [method, url, payload] of [
      ['GET', `/photos/${mine.id}`],
      ['GET', `/photos/${mine.id}/thumbnail`],
      ['GET', `/photos/${mine.id}/info`],
      ['PATCH', `/photos/${mine.id}`, { caption: 'hacked' }],
      ['DELETE', `/photos/${mine.id}`],
    ] as const) {
      expect((await call(other, method, url, payload)).statusCode, `${method} ${url}`).toBe(404);
    }
    expect((await upload(other, `/entries/${mine.registro_id}/photos`, [{ data: await png(40, 40) }])).statusCode).toBe(404);
    expect((await upload(other, `/events/${mine.registro_id}/photos`, [{ data: await png(40, 40) }])).statusCode).toBe(404);
    expect((await upload(other, `/reports/${report}/area-photo`, [{ data: await png(40, 40) }])).statusCode).toBe(404);
    expect((await call(me, 'GET', `/photos/${mine.id}`)).statusCode).toBe(200);
  });

  it('upload without a token is 401', async () => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(await png(10, 10))]), 'a.png');
    const response = new Response(form);
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/entries/${entry}/photos`,
      headers: { 'content-type': response.headers.get('content-type')! },
      payload: Buffer.from(await response.arrayBuffer()),
    });
    expect(r.statusCode).toBe(401);
  });
});
