import { randomUUID } from 'node:crypto';
import multipart from '@fastify/multipart';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { audioFiles } from '../audios/audios.js';
import type { AppContext } from '../context.js';
import { inTransaction, pageOf, pageQuery, uuid, type Db } from '../lib/common.js';
import { setTags, tagNames } from '../lib/tags.js';
import { isDecodable, makeThumbnail, sniffAttachmentMime, type AttachmentMime } from '../media/storage.js';
import { attachmentFiles, fetchAttachments, fetchNotes, findAttachmentRow, findNote, MAX_ATTACHMENTS_PER_NOTE } from '../notes/notes.js';
import { findActivePeriod } from '../periods/periods.js';
import { ApiError, validate } from './errors.js';
import { indexNote, removeFromIndex } from '../search/index.js';
import { requireAuth } from './require-auth.js';

const MAX_BYTES = 10 * 1024 * 1024;

// Same rule as the CHECK in the database: only http:// and https:// links
const link = z
  .string()
  .trim()
  .max(500)
  .refine((v) => /^https?:\/\//i.test(v), 'The link must start with http:// or https://.');

export const createBody = z.object({
  id: uuid.optional(),
  title: z.string().trim().min(1, 'Enter the title.').max(160),
  text: z.string().max(1_000_000).nullable().optional(),
  subject_id: uuid.nullable().optional(),
  link: link.nullable().optional(),
  tags: tagNames.optional(),
  pinned: z.boolean().optional(),
});

export const patchBody = z
  .object({
    title: z.string().trim().min(1).max(160),
    text: z.string().max(1_000_000).nullable(),
    subject_id: uuid.nullable(),
    link: link.nullable(),
    tags: tagNames,
    pinned: z.boolean(),
  })
  .partial()
  .strict();

export const listQuery = pageQuery.extend({
  scope: z.enum(['all', 'loose', 'with_subject']).default('all'),
  subject_id: uuid.optional(),
  tag: z.string().trim().min(1).max(60).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  period_id: uuid.optional(),
  period: z.literal('active').optional(),
});

function fieldError(field: string, message: string): ApiError {
  return new ApiError(422, 'validation', 'Some fields are invalid.', [{ field, message }]);
}

export const noteRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const { pool, media } = ctx;
    app.register(multipart, { limits: { fileSize: MAX_BYTES, files: MAX_ATTACHMENTS_PER_NOTE, fields: 5 } });
    app.addHook('preHandler', requireAuth(ctx));

    /**
     * The subject must be the user's own. A new link goes to a subject of the active period; keeping the
     * subject the note already has (even in a finished period) is fine, as is any subject of its own period.
     */
    async function checkSubject(
      db: Db,
      userId: string,
      subjectId: string | null | undefined,
      currentPeriodId: string | null = null,
    ): Promise<void> {
      if (!subjectId) return;
      const [rows] = await db.query<RowDataPacket[]>(
        'SELECT m.periodo_id, p.status FROM materia m JOIN periodo p ON p.usuario_id = m.usuario_id AND p.id = m.periodo_id WHERE m.usuario_id = ? AND m.id = ?',
        [userId, subjectId],
      );
      const subject = rows[0];
      if (!subject) throw fieldError('subject_id', 'Subject not found.');
      if (subject.status !== 'ativo' && subject.periodo_id !== currentPeriodId) {
        throw new ApiError(409, 'period_finished', 'Notes can only move to a subject of the active period.');
      }
    }

    app.get('/notes', async (req) => {
      const q = validate(listQuery, req.query);
      const where: string[] = [];
      const params: unknown[] = [];
      if (q.scope === 'loose') where.push('a.materia_id IS NULL');
      if (q.scope === 'with_subject') where.push('a.materia_id IS NOT NULL');
      if (q.subject_id) {
        where.push('a.materia_id = ?');
        params.push(q.subject_id);
      }
      if (q.period_id) {
        where.push('m.periodo_id = ?');
        params.push(q.period_id);
      }
      if (q.period === 'active') {
        where.push('m.periodo_id <=> ?');
        params.push((await findActivePeriod(pool, req.userId))?.id ?? null);
      }
      if (q.tag) {
        where.push(`EXISTS (SELECT 1 FROM anotacao_tag l JOIN tag t ON t.usuario_id = l.usuario_id AND t.id = l.tag_id
                             WHERE l.usuario_id = a.usuario_id AND l.anotacao_id = a.id AND t.nome = ?)`);
        params.push(q.tag);
      }
      if (q.q) {
        const like = `%${q.q.replace(/[\\%_]/g, '\\$&')}%`;
        where.push(`(a.titulo LIKE ? OR a.texto LIKE ? OR EXISTS (
            SELECT 1 FROM anotacao_tag l JOIN tag t ON t.usuario_id = l.usuario_id AND t.id = l.tag_id
             WHERE l.usuario_id = a.usuario_id AND l.anotacao_id = a.id AND t.nome LIKE ?))`);
        params.push(like, like, like);
      }
      const filter = { sql: where.length ? where.join(' AND ') : '1 = 1', params };
      const [count] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM anotacao a LEFT JOIN materia m ON m.usuario_id = a.usuario_id AND m.id = a.materia_id WHERE a.usuario_id = ? AND ${filter.sql}`,
        [req.userId, ...params],
      );
      const items = await fetchNotes(pool, req.userId, filter, { paging: { limit: q.limit, offset: (q.page - 1) * q.limit } });
      return pageOf(items, q.page, q.limit, Number(count[0]?.n ?? 0));
    });

    app.post('/notes', async (req, reply) => {
      const b = validate(createBody, req.body);
      const id = b.id ?? randomUUID();
      await inTransaction(pool, async (tx) => {
        await checkSubject(tx, req.userId, b.subject_id);
        await tx.query('INSERT INTO anotacao (id, usuario_id, materia_id, titulo, texto, link, fixada) VALUES (?, ?, ?, ?, ?, ?, ?)', [
          id,
          req.userId,
          b.subject_id ?? null,
          b.title,
          b.text ?? null,
          b.link ?? null,
          b.pinned ? 1 : 0,
        ]);
        if (b.tags) await setTags(tx, req.userId, { table: 'anotacao_tag', owner: 'anotacao_id' }, id, b.tags, false); // new item: no version bump
        await indexNote(tx, req.userId, id);
      });
      return reply.status(201).send(await findNote(pool, req.userId, id));
    });

    app.get<{ Params: { id: string } }>('/notes/:id', async (req) => findNote(pool, req.userId, validate(uuid, req.params.id)));

    // Notes stay editable after their period ends (personal content), except moving to a subject of another finished period.
    app.patch<{ Params: { id: string } }>('/notes/:id', async (req) => {
      const id = validate(uuid, req.params.id);
      const b = validate(patchBody, req.body);
      const current = await findNote(pool, req.userId, id);
      await inTransaction(pool, async (tx) => {
        if (b.subject_id !== undefined && b.subject_id !== current.subject?.id)
          await checkSubject(tx, req.userId, b.subject_id, current.period_id);
        const sets: string[] = [];
        const values: unknown[] = [];
        const set = (column: string, value: unknown) => {
          sets.push(`${column} = ?`);
          values.push(value);
        };
        if (b.title !== undefined) set('titulo', b.title);
        if (b.text !== undefined) set('texto', b.text);
        if (b.subject_id !== undefined) set('materia_id', b.subject_id);
        if (b.link !== undefined) set('link', b.link);
        if (b.pinned !== undefined) set('fixada', b.pinned ? 1 : 0);
        if (b.tags !== undefined && !sets.length) sets.push('titulo = titulo'); // touch the row so `version` goes up
        if (sets.length)
          await tx.query(`UPDATE anotacao SET ${sets.join(', ')} WHERE usuario_id = ? AND id = ?`, [...values, req.userId, id]);
        if (b.tags !== undefined) await setTags(tx, req.userId, { table: 'anotacao_tag', owner: 'anotacao_id' }, id, b.tags);
        await indexNote(tx, req.userId, id);
      });
      return findNote(pool, req.userId, id);
    });

    // No reminder and no notification for notes.
    app.delete<{ Params: { id: string } }>('/notes/:id', async (req, reply) => {
      const id = validate(uuid, req.params.id);
      await findNote(pool, req.userId, id);
      const files = [
        ...(await attachmentFiles(pool, req.userId, 'anotacao_id = ?', [id])),
        ...(await audioFiles(pool, req.userId, 'anotacao_id = ?', [id])),
      ];
      await pool.query('DELETE FROM anotacao WHERE usuario_id = ? AND id = ?', [req.userId, id]);
      await removeFromIndex(pool, 'anotacao', [id]);
      await media.remove(files);
      return reply.status(204).send();
    });

    // Attachments: a photo or a PDF, up to 10 MB each.
    app.post<{ Params: { id: string } }>('/notes/:id/attachments', async (req, reply) => {
      const noteId = validate(uuid, req.params.id);
      await findNote(pool, req.userId, noteId);

      const files: Buffer[] = [];
      let clientId: string | undefined;
      for await (const part of req.parts()) {
        if (part.type !== 'file') {
          if (part.fieldname === 'attachment_id' && typeof part.value === 'string') clientId = part.value;
          continue;
        }
        if (part.fieldname !== 'file') throw fieldError('file', 'Send the files in the "file" field.');
        files.push(await part.toBuffer()); // 413 above the size limit
      }
      if (!files.length) throw fieldError('file', 'Send at least one file in the "file" field.');
      if (clientId !== undefined && (!uuid.safeParse(clientId).success || files.length > 1))
        throw fieldError('attachment_id', 'attachment_id must be a UUID and works with a single file.');

      const prepared: {
        id: string;
        buffer: Buffer;
        mime: AttachmentMime;
        thumbnail: Buffer | null;
        path: string;
        thumbPath: string | null;
      }[] = [];
      for (const buffer of files) {
        const mime = buffer.length ? sniffAttachmentMime(buffer) : null;
        if (!mime) throw fieldError('file', 'Only photos (JPEG, PNG, WebP, HEIC) and PDF files are accepted.');
        if (mime !== 'application/pdf' && mime !== 'image/heic' && !(await isDecodable(buffer)))
          throw fieldError('file', 'The file is not a valid image.');
        const id = clientId ?? randomUUID();
        const thumbnail = mime === 'application/pdf' ? null : await makeThumbnail(buffer);
        prepared.push({
          id,
          buffer,
          mime,
          thumbnail,
          path: media.attachmentPath(req.userId, id, mime),
          thumbPath: thumbnail ? media.attachmentThumbnailPath(req.userId, id) : null,
        });
      }

      const [count] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM anexo WHERE usuario_id = ? AND anotacao_id = ?', [
        req.userId,
        noteId,
      ]);
      if (Number(count[0]?.n ?? 0) + prepared.length > MAX_ATTACHMENTS_PER_NOTE) {
        throw fieldError('file', `At most ${MAX_ATTACHMENTS_PER_NOTE} attachments per note.`);
      }

      const written: string[] = [];
      try {
        for (const p of prepared) {
          await media.save(p.path, p.buffer);
          written.push(p.path);
          if (p.thumbnail && p.thumbPath) {
            await media.save(p.thumbPath, p.thumbnail);
            written.push(p.thumbPath);
          }
        }
        await inTransaction(pool, async (tx) => {
          for (const p of prepared) {
            await tx.query(
              'INSERT INTO anexo (id, usuario_id, anotacao_id, arquivo, miniatura, tipo_mime, tamanho_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [p.id, req.userId, noteId, p.path, p.thumbPath, p.mime, p.buffer.length],
            );
          }
          // the note changed: moves its `updated_at` and `version` for the sync
          await tx.query('UPDATE anotacao SET titulo = titulo WHERE usuario_id = ? AND id = ?', [req.userId, noteId]);
        });
      } catch (e) {
        await media.remove(written);
        throw e;
      }
      return reply.status(201).send({ items: await fetchAttachments(pool, req.userId, 'id IN (?)', [prepared.map((p) => p.id)]) });
    });

    app.get<{ Params: { id: string } }>('/attachments/:id', async (req, reply) => {
      const row = await findAttachmentRow(pool, req.userId, validate(uuid, req.params.id));
      if (!row.arquivo) throw new ApiError(404, 'not_found', 'Attachment file not found.');
      const pdf = row.tipo_mime === 'application/pdf';
      return send(
        reply,
        media.stream(row.arquivo as string),
        row.tipo_mime as string,
        row.tamanho_bytes as number,
        pdf ? 'attachment' : 'inline',
      );
    });

    app.get<{ Params: { id: string } }>('/attachments/:id/thumbnail', async (req, reply) => {
      const row = await findAttachmentRow(pool, req.userId, validate(uuid, req.params.id));
      if (!row.miniatura) throw new ApiError(404, 'not_found', 'This attachment has no thumbnail.');
      return send(reply, media.stream(row.miniatura as string), 'image/jpeg', undefined, 'inline');
    });

    app.delete<{ Params: { id: string } }>('/attachments/:id', async (req, reply) => {
      const row = await findAttachmentRow(pool, req.userId, validate(uuid, req.params.id));
      await pool.query('DELETE FROM anexo WHERE usuario_id = ? AND id = ?', [req.userId, row.id]);
      await pool.query('UPDATE anotacao SET titulo = titulo WHERE usuario_id = ? AND id = ?', [req.userId, row.anotacao_id]);
      await media.remove([row.arquivo as string | null, row.miniatura as string | null]);
      return reply.status(204).send();
    });
  };

function send(
  reply: FastifyReply,
  stream: NodeJS.ReadableStream,
  mime: string,
  size: number | undefined,
  disposition: 'inline' | 'attachment',
) {
  reply
    .header('content-type', mime)
    .header('content-disposition', disposition)
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', 'private, max-age=3600');
  if (size) reply.header('content-length', size);
  return reply.send(stream);
}
