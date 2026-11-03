import { randomUUID } from 'node:crypto';
import multipart from '@fastify/multipart';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { findAudioRow, MAX_AUDIO_BYTES, MAX_AUDIO_SECONDS, MAX_AUDIOS_PER_PARENT, serializeAudio } from '../audios/audios.js';
import type { AppContext } from '../context.js';
import { findEntry } from '../entries/entries.js';
import { uuid, type Db } from '../lib/common.js';
import { sniffAudioMime } from '../media/storage.js';
import { findNote } from '../notes/notes.js';
import { assertReportOpen, findReport } from '../reports/reports.js';
import { ApiError, validate } from './errors.js';
import { indexAudioParent } from '../search/index.js';
import { requireAuth } from './require-auth.js';

export const fieldsSchema = z.object({
  audio_id: uuid.optional(),
  duration_s: z.coerce.number().int().min(1, 'The audio is too short.').max(MAX_AUDIO_SECONDS, `At most ${MAX_AUDIO_SECONDS} seconds.`),
  recorded_at: z.iso.datetime({ offset: true }),
});

export const patchBody = z.object({ edited_transcription: z.string().max(50000).nullable() }).strict();

function fieldError(field: string, message: string): ApiError {
  return new ApiError(422, 'validation', 'Some fields are invalid.', [{ field, message }]);
}

type Parent = { column: 'registro_id' | 'anotacao_id'; id: string };

export const audioRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const { pool, media } = ctx;
    app.register(multipart, { limits: { fileSize: MAX_AUDIO_BYTES, files: 1, fields: 10 } });
    app.addHook('preHandler', requireAuth(ctx));

    /**
     * Throws unless the parent can still take changes. An entry follows its report (finished report or
     * period = read-only); a note is personal content and always editable. A missing parent is a 404.
     */
    async function assertEditable(db: Db, userId: string, parent: Parent): Promise<void> {
      if (parent.column === 'anotacao_id') {
        await findNote(db, userId, parent.id);
        return;
      }
      const entry = await findEntry(db, userId, parent.id);
      assertReportOpen(await findReport(db, userId, entry.report_id));
    }

    const parentOf = (row: RowDataPacket): Parent =>
      row.registro_id ? { column: 'registro_id', id: row.registro_id as string } : { column: 'anotacao_id', id: row.anotacao_id as string };

    // The upload answers right away; the transcription happens later, in the worker.
    async function receive(req: FastifyRequest, parent: Parent) {
      await assertEditable(pool, req.userId, parent);

      let file: Buffer | null = null;
      const raw: Record<string, string> = {};
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file' || file) throw fieldError('file', 'Send one audio in the "file" field.');
          file = await part.toBuffer(); // 413 above the size limit
        } else if (typeof part.value === 'string') {
          raw[part.fieldname] = part.value;
        }
      }
      if (!file?.length) throw fieldError('file', 'Send the audio in the "file" field.');
      const fields = validate(fieldsSchema, raw);
      const mime = sniffAudioMime(file);
      if (!mime) throw fieldError('file', 'Only m4a/mp4, aac, ogg and webm audio is accepted.');

      const [count] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM audio WHERE usuario_id = ? AND ${parent.column} = ?`, [
        req.userId,
        parent.id,
      ]);
      if (Number(count[0]?.n ?? 0) >= MAX_AUDIOS_PER_PARENT) throw fieldError('file', `At most ${MAX_AUDIOS_PER_PARENT} audios here.`);

      const id = fields.audio_id ?? randomUUID();
      const path = media.audioPath(req.userId, id, mime);
      await media.save(path, file);
      try {
        await pool.query(
          `INSERT INTO audio (id, usuario_id, ${parent.column}, arquivo, tipo_mime, duracao_s, tamanho_bytes, gravado_em, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'transcrevendo')`,
          [id, req.userId, parent.id, path, mime, fields.duration_s, file.length, new Date(fields.recorded_at)],
        );
      } catch (e) {
        await media.remove([path]);
        throw e;
      }
      return serializeAudio(await findAudioRow(pool, req.userId, id));
    }

    app.post<{ Params: { id: string } }>('/entries/:id/audios', async (req, reply) =>
      reply.status(201).send(await receive(req, { column: 'registro_id', id: validate(uuid, req.params.id) })),
    );

    app.post<{ Params: { id: string } }>('/notes/:id/audios', async (req, reply) =>
      reply.status(201).send(await receive(req, { column: 'anotacao_id', id: validate(uuid, req.params.id) })),
    );

    app.get<{ Params: { id: string } }>('/audios/:id', async (req) =>
      serializeAudio(await findAudioRow(pool, req.userId, validate(uuid, req.params.id))),
    );

    app.get<{ Params: { id: string } }>('/audios/:id/file', async (req, reply) => {
      const row = await findAudioRow(pool, req.userId, validate(uuid, req.params.id));
      if (!row.arquivo) throw new ApiError(404, 'not_found', 'The audio file was deleted after transcription.');
      return reply
        .header('content-type', row.tipo_mime as string)
        .header('content-length', row.tamanho_bytes as number)
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, max-age=3600')
        .send(media.stream(row.arquivo as string));
    });

    // What the user fixed always wins over the machine text, and the machine never overwrites it.
    app.patch<{ Params: { id: string } }>('/audios/:id', async (req) => {
      const id = validate(uuid, req.params.id);
      const b = validate(patchBody, req.body);
      const row = await findAudioRow(pool, req.userId, id);
      await assertEditable(pool, req.userId, parentOf(row));
      await pool.query('UPDATE audio SET transcricao_editada = ? WHERE usuario_id = ? AND id = ?', [
        b.edited_transcription,
        req.userId,
        id,
      ]);
      await indexAudioParent(pool, req.userId, { entryId: row.registro_id as string | null, noteId: row.anotacao_id as string | null });
      return serializeAudio(await findAudioRow(pool, req.userId, id));
    });

    app.post<{ Params: { id: string } }>('/audios/:id/retranscribe', async (req, reply) => {
      const id = validate(uuid, req.params.id);
      const row = await findAudioRow(pool, req.userId, id);
      await assertEditable(pool, req.userId, parentOf(row));
      if (!row.arquivo) throw new ApiError(409, 'audio_file_deleted', 'The audio file was deleted, so it cannot be transcribed again.');
      await pool.query("UPDATE audio SET status = 'transcrevendo', tentativas = 0, erro = NULL WHERE usuario_id = ? AND id = ?", [
        req.userId,
        id,
      ]);
      return reply.status(202).send(serializeAudio(await findAudioRow(pool, req.userId, id)));
    });

    app.delete<{ Params: { id: string } }>('/audios/:id', async (req, reply) => {
      const id = validate(uuid, req.params.id);
      const row = await findAudioRow(pool, req.userId, id);
      await assertEditable(pool, req.userId, parentOf(row));
      await pool.query('DELETE FROM audio WHERE usuario_id = ? AND id = ?', [req.userId, id]);
      await indexAudioParent(pool, req.userId, { entryId: row.registro_id as string | null, noteId: row.anotacao_id as string | null });
      await media.remove([row.arquivo as string | null]);
      return reply.status(204).send();
    });
  };
