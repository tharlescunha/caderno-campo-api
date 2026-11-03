import { randomUUID } from 'node:crypto';
import multipart from '@fastify/multipart';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { findEntry } from '../entries/entries.js';
import { checkEventSubject, findEvent } from '../events/events.js';
import { inTransaction, uuid, type Db } from '../lib/common.js';
import { isDecodable, makeThumbnail, sniffPhotoMime, type PhotoMime } from '../media/storage.js';
import { fetchPhotos, findPhotoRow, MAX_PHOTOS_PER_PARENT, photoFiles, serializePhoto } from '../photos/photos.js';
import { assertReportOpen, findReport } from '../reports/reports.js';
import { ApiError, validate } from './errors.js';
import { requireAuth } from './require-auth.js';

const MAX_BYTES = 10 * 1024 * 1024;

export const fieldsSchema = z.object({
  photo_id: uuid.optional(),
  caption: z.string().trim().max(200).optional(),
  taken_at: z.iso.datetime({ offset: true }).optional(),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
});

export const patchBody = z.object({ caption: z.string().trim().max(200).nullable() }).strict();

function fieldError(field: string, message: string): ApiError {
  return new ApiError(422, 'validation', 'Some fields are invalid.', [{ field, message }]);
}

type Parent = { column: 'registro_id' | 'relatorio_id' | 'evento_id'; id: string };

export const photoRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const { pool, media } = ctx;
    app.register(multipart, { limits: { fileSize: MAX_BYTES, files: MAX_PHOTOS_PER_PARENT, fields: 10 } });
    app.addHook('preHandler', requireAuth(ctx));

    /** Throws unless the thing the photo hangs on can still be changed. */
    async function assertParentEditable(db: Db, userId: string, parent: Parent): Promise<void> {
      if (parent.column === 'registro_id') {
        const entry = await findEntry(db, userId, parent.id);
        assertReportOpen(await findReport(db, userId, entry.report_id));
      } else if (parent.column === 'relatorio_id') {
        assertReportOpen(await findReport(db, userId, parent.id));
      } else {
        const event = await findEvent(db, userId, parent.id);
        await checkEventSubject(db, userId, event.materia_id as string | null);
      }
    }

    /** Reads the multipart body: every `file` part plus the text fields (which apply to all files of the request). */
    async function readUpload(req: FastifyRequest) {
      const files: Buffer[] = [];
      const raw: Record<string, string> = {};
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file') throw fieldError('file', 'Send the image in the "file" field.');
          files.push(await part.toBuffer()); // throws 413 above the size limit
        } else if (typeof part.value === 'string') {
          raw[part.fieldname] = part.value;
        }
      }
      if (!files.length) throw fieldError('file', 'Send at least one image in the "file" field.');
      const fields = validate(fieldsSchema, raw);
      if (fields.photo_id && files.length > 1) throw fieldError('photo_id', 'photo_id only works with a single file.');
      if ((fields.latitude === undefined) !== (fields.longitude === undefined))
        throw fieldError('longitude', 'Send latitude and longitude together.');
      return { files, fields };
    }

    /** Checks, stores and records the uploaded images under `parent`. Returns the new photos. */
    async function storePhotos(req: FastifyRequest, parent: Parent, options: { replace?: boolean } = {}) {
      const userId = req.userId;
      const { files, fields } = await readUpload(req);

      const prepared: { buffer: Buffer; mime: PhotoMime; id: string; thumbnail: Buffer | null; path: string; thumbPath: string | null }[] =
        [];
      for (const buffer of files) {
        const mime = buffer.length ? sniffPhotoMime(buffer) : null;
        if (!mime) throw fieldError('file', 'Only JPEG, PNG, WebP and HEIC images are accepted.');
        if (mime !== 'image/heic' && !(await isDecodable(buffer))) throw fieldError('file', 'The file is not a valid image.');
        const id = fields.photo_id ?? randomUUID();
        const thumbnail = await makeThumbnail(buffer);
        prepared.push({
          buffer,
          mime,
          id,
          thumbnail,
          path: media.photoPath(userId, id, mime),
          thumbPath: thumbnail ? media.thumbnailPath(userId, id) : null,
        });
      }

      const [count] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM foto WHERE usuario_id = ? AND ${parent.column} = ?`, [
        userId,
        parent.id,
      ]);
      const existing = options.replace ? 0 : Number(count[0]?.n ?? 0);
      if (existing + prepared.length > MAX_PHOTOS_PER_PARENT) throw fieldError('file', `At most ${MAX_PHOTOS_PER_PARENT} photos here.`);

      const written: string[] = [];
      let oldFiles: string[] = [];
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
          if (options.replace) {
            oldFiles = await photoFiles(tx, userId, `${parent.column} = ?`, [parent.id]);
            await tx.query(`DELETE FROM foto WHERE usuario_id = ? AND ${parent.column} = ?`, [userId, parent.id]);
          }
          for (const p of prepared) {
            await tx.query(
              `INSERT INTO foto (id, usuario_id, ${parent.column}, arquivo, miniatura, tipo_mime, tamanho_bytes, legenda, tirada_em, latitude, longitude)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                p.id,
                userId,
                parent.id,
                p.path,
                p.thumbPath,
                p.mime,
                p.buffer.length,
                fields.caption ?? null,
                fields.taken_at ? new Date(fields.taken_at) : null,
                fields.latitude ?? null,
                fields.longitude ?? null,
              ],
            );
          }
          if (options.replace && parent.column === 'relatorio_id') {
            await tx.query('UPDATE relatorio SET area_foto_id = ? WHERE usuario_id = ? AND id = ?', [prepared[0]?.id, userId, parent.id]);
          }
        });
      } catch (e) {
        await media.remove(written); // nothing is left behind when the database refuses
        throw e;
      }
      await media.remove(oldFiles);
      return fetchPhotos(pool, userId, 'id IN (?)', [prepared.map((p) => p.id)]);
    }

    app.post<{ Params: { id: string } }>('/entries/:id/photos', async (req, reply) => {
      const parent: Parent = { column: 'registro_id', id: validate(uuid, req.params.id) };
      await assertParentEditable(pool, req.userId, parent);
      return reply.status(201).send({ items: await storePhotos(req, parent) });
    });

    app.post<{ Params: { id: string } }>('/events/:id/photos', async (req, reply) => {
      const parent: Parent = { column: 'evento_id', id: validate(uuid, req.params.id) };
      await assertParentEditable(pool, req.userId, parent);
      return reply.status(201).send({ items: await storePhotos(req, parent) });
    });

    // One photo of the area per report: a new one replaces the old one.
    app.post<{ Params: { id: string } }>('/reports/:id/area-photo', async (req, reply) => {
      const id = validate(uuid, req.params.id);
      const report = await findReport(pool, req.userId, id);
      if (report.type !== 'continuous') throw fieldError('type', 'Only continuous reports have an area photo.');
      const parent: Parent = { column: 'relatorio_id', id };
      await assertParentEditable(pool, req.userId, parent);
      const [photo] = await storePhotos(req, parent, { replace: true });
      return reply.status(201).send(photo);
    });

    app.get<{ Params: { id: string } }>('/photos/:id/info', async (req) =>
      serializePhoto(await findPhotoRow(pool, req.userId, validate(uuid, req.params.id))),
    );

    app.patch<{ Params: { id: string } }>('/photos/:id', async (req) => {
      const id = validate(uuid, req.params.id);
      const b = validate(patchBody, req.body);
      const row = await findPhotoRow(pool, req.userId, id);
      await assertParentEditable(pool, req.userId, parentOf(row));
      await pool.query('UPDATE foto SET legenda = ? WHERE usuario_id = ? AND id = ?', [b.caption, req.userId, id]);
      return serializePhoto(await findPhotoRow(pool, req.userId, id));
    });

    app.delete<{ Params: { id: string } }>('/photos/:id', async (req, reply) => {
      const id = validate(uuid, req.params.id);
      const row = await findPhotoRow(pool, req.userId, id);
      await assertParentEditable(pool, req.userId, parentOf(row));
      await inTransaction(pool, async (tx) => {
        await tx.query('UPDATE relatorio SET area_foto_id = NULL WHERE usuario_id = ? AND area_foto_id = ?', [req.userId, id]);
        await tx.query('UPDATE relatorio SET capa_foto_id = NULL WHERE usuario_id = ? AND capa_foto_id = ?', [req.userId, id]);
        await tx.query('DELETE FROM foto WHERE usuario_id = ? AND id = ?', [req.userId, id]);
      });
      await media.remove([row.arquivo as string | null, row.miniatura as string | null]);
      return reply.status(204).send();
    });

    // The files: only for the owner, never public, never guessed as another type.
    app.get<{ Params: { id: string } }>('/photos/:id', async (req, reply) => {
      const row = await findPhotoRow(pool, req.userId, validate(uuid, req.params.id));
      if (!row.arquivo) throw new ApiError(404, 'not_found', 'Photo file not found.');
      return sendFile(reply, media.stream(row.arquivo as string), row.tipo_mime as string, row.tamanho_bytes as number);
    });

    app.get<{ Params: { id: string } }>('/photos/:id/thumbnail', async (req, reply) => {
      const row = await findPhotoRow(pool, req.userId, validate(uuid, req.params.id));
      if (!row.miniatura) throw new ApiError(404, 'not_found', 'This photo has no thumbnail.');
      return sendFile(reply, media.stream(row.miniatura as string), 'image/jpeg');
    });
  };

function parentOf(row: RowDataPacket): Parent {
  if (row.registro_id) return { column: 'registro_id', id: row.registro_id as string };
  if (row.relatorio_id) return { column: 'relatorio_id', id: row.relatorio_id as string };
  return { column: 'evento_id', id: row.evento_id as string };
}

function sendFile(reply: import('fastify').FastifyReply, stream: NodeJS.ReadableStream, mime: string, size?: number) {
  reply.header('content-type', mime).header('x-content-type-options', 'nosniff').header('cache-control', 'private, max-age=3600');
  if (size) reply.header('content-length', size);
  return reply.send(stream);
}
