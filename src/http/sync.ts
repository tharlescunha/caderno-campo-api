import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { uuid } from '../lib/common.js';
import { InternalClient, itemPath, SYNC_ENTITIES, type SyncEntity } from '../sync/internal.js';
import { sendSchema, SyncSender } from '../sync/send.js';
import { ApiError, validate } from './errors.js';
import { requireAuth } from './require-auth.js';

const MIN_APP_VERSION = '1.0.0';
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

/** The cursor is the log sequence number, as text with leading zeros: "000000123". */
const toCursor = (seq: number | bigint | string) => String(seq).padStart(9, '0');

export const changesQuery = z.object({
  cursor: z
    .string()
    .regex(/^\d{1,18}$/, 'Use the cursor the server gave you.')
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

// What a media upload is attached to, and which route and id field take it
const MEDIA = {
  entry: { url: (id: string) => `/entries/${id}/photos`, idField: 'photo_id', table: 'foto' },
  report_area: { url: (id: string) => `/reports/${id}/area-photo`, idField: 'photo_id', table: 'foto' },
  event: { url: (id: string) => `/events/${id}/photos`, idField: 'photo_id', table: 'foto' },
  note: { url: (id: string) => `/notes/${id}/attachments`, idField: 'attachment_id', table: 'anexo' },
  entry_audio: { url: (id: string) => `/entries/${id}/audios`, idField: 'audio_id', table: 'audio' },
  note_audio: { url: (id: string) => `/notes/${id}/audios`, idField: 'audio_id', table: 'audio' },
} as const;
type MediaKind = keyof typeof MEDIA;

export const mediaFields = z.object({
  entity: z.enum(Object.keys(MEDIA) as [MediaKind, ...MediaKind[]]),
  entity_id: uuid,
  photo_id: uuid.optional(),
  audio_id: uuid.optional(),
  attachment_id: uuid.optional(),
});

export const syncRoutes =
  (ctx: AppContext, root: FastifyInstance): FastifyPluginAsync =>
  async (app) => {
    const { pool } = ctx;
    app.register(multipart, { limits: { fileSize: MAX_MEDIA_BYTES, files: 1, fields: 12 } });
    app.addHook('preHandler', requireAuth(ctx));
    // the account may have been deleted from another place: tell the phone, so it can clean up
    app.addHook('preHandler', async (req) => {
      const [rows] = await pool.query<RowDataPacket[]>('SELECT 1 FROM usuario WHERE id = ?', [req.userId]);
      if (!rows[0]) throw new ApiError(401, 'account_removed', 'This account was deleted.');
    });

    const clientFor = (userId: string) => new InternalClient(root, userId, ctx.config.jwtSecret);
    const currentSeq = async (userId: string) => {
      const [rows] = await pool.query<RowDataPacket[]>('SELECT COALESCE(MAX(seq), 0) AS seq FROM mudanca WHERE usuario_id = ?', [userId]);
      return Number(rows[0]?.seq ?? 0);
    };

    // A batch of operations made offline, applied in order; one failing does not stop the next ones.
    app.post('/sync/send', async (req) => {
      const body = validate(sendSchema, req.body);
      // the cursor BEFORE the batch: changes made elsewhere meanwhile are not skipped (the phone's own come back, harmless)
      const cursor = toCursor(await currentSeq(req.userId));
      const results = await new SyncSender(pool, clientFor(req.userId), req.userId).run(body.device_id, body.operations);
      return { results, cursor };
    });

    // What changed on the server since the cursor (no cursor = everything, in pages).
    app.get('/sync/changes', async (req) => {
      const q = validate(changesQuery, req.query);
      const after = Number(q.cursor ?? 0);
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT seq, entidade, entidade_id, operacao FROM mudanca WHERE usuario_id = ? AND seq > ? ORDER BY seq LIMIT ?',
        [req.userId, after, q.limit + 1],
      );
      const hasMore = rows.length > q.limit;
      const page = rows.slice(0, q.limit);

      // one entry per item, in the order the items first appeared (parents before children); its value is the one NOW
      const groups = new Map<string, { entity: SyncEntity; id: string; last: string }>();
      for (const r of page) {
        if (!SYNC_ENTITIES.includes(r.entidade as SyncEntity)) continue;
        const key = `${r.entidade}:${r.entidade_id}`;
        const group = groups.get(key) ?? { entity: r.entidade as SyncEntity, id: r.entidade_id as string, last: r.operacao as string };
        group.last = r.operacao as string;
        groups.set(key, group);
      }
      const client = clientFor(req.userId);
      const changes: { entity: SyncEntity; operation: 'upsert' | 'delete'; id: string; version?: number; item?: unknown }[] = [];
      for (const g of groups.values()) {
        if (g.last === 'excluir') {
          changes.push({ entity: g.entity, operation: 'delete', id: g.id });
          continue;
        }
        const response = await client.call('GET', itemPath(g.entity, g.id));
        // gone since (a later delete is further on in the log, or came with a cascade)
        if (response.status === 404) changes.push({ entity: g.entity, operation: 'delete', id: g.id });
        else if (response.status === 200)
          changes.push({ entity: g.entity, operation: 'upsert', id: g.id, version: response.body.version, item: response.body });
      }
      const last = page.at(-1);
      return { changes, cursor: toCursor(last ? Number(last.seq) : after), has_more: hasMore };
    });

    // Photos, attachments and audios, one per request. Repeating the same id returns the file already stored.
    app.post('/sync/media', async (req, reply) => {
      const parts: { name: string; value: string }[] = [];
      let file: { data: Buffer; filename: string; type: string } | null = null;
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file' || file)
            throw new ApiError(422, 'validation', 'Some fields are invalid.', [
              { field: 'file', message: 'Send one file in the "file" field.' },
            ]);
          file = { data: await part.toBuffer(), filename: part.filename, type: part.mimetype };
        } else if (typeof part.value === 'string') {
          parts.push({ name: part.fieldname, value: part.value });
        }
      }
      const fields = validate(mediaFields, Object.fromEntries(parts.map((p) => [p.name, p.value])));
      if (!file)
        throw new ApiError(422, 'validation', 'Some fields are invalid.', [
          { field: 'file', message: 'Send the file in the "file" field.' },
        ]);
      const target = MEDIA[fields.entity];
      const clientId = fields[target.idField as 'photo_id' | 'audio_id' | 'attachment_id'];

      const client = clientFor(req.userId);
      if (clientId) {
        const [exists] = await pool.query<RowDataPacket[]>(`SELECT 1 FROM ${target.table} WHERE usuario_id = ? AND id = ?`, [
          req.userId,
          clientId,
        ]);
        if (exists[0]) {
          const path = target.table === 'foto' ? `/photos/${clientId}/info` : target.table === 'audio' ? `/audios/${clientId}` : null;
          const item = path ? (await client.call('GET', path)).body : { id: clientId };
          return reply.status(200).send({ status: 'already_processed', item });
        }
      }

      // forward as a normal upload to the route that already has all the rules
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(file.data)], { type: file.type }), file.filename || 'file');
      const skip = new Set(['entity', 'entity_id']);
      for (const p of parts) if (!skip.has(p.name)) form.append(p.name, p.value);
      const wrapped = new Response(form);
      const response = await client.call('POST', target.url(fields.entity_id), Buffer.from(await wrapped.arrayBuffer()), {
        'content-type': wrapped.headers.get('content-type')!,
      });
      if (response.status >= 300) {
        const e = response.body?.error;
        throw new ApiError(response.status, e?.code ?? 'error', e?.message ?? 'The upload failed.', e?.fields, e?.details);
      }
      const item = Array.isArray(response.body?.items) ? response.body.items[0] : response.body;
      return reply.status(201).send({ status: 'ok', item });
    });

    app.get('/sync/state', async (req) => ({
      current_cursor: toCursor(await currentSeq(req.userId)),
      server_time: new Date().toISOString(),
      min_app_version: MIN_APP_VERSION,
    }));
  };
