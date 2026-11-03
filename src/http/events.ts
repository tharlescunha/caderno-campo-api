import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { checkEventSubject, EVENT_COLUMNS, findEvent, serializeEvent } from '../events/events.js';
import { dateOnly, eventType, pageOf, pageQuery, reminder, uuid } from '../lib/common.js';
import { fetchPhotos, PHOTOS_OF_EVENT, photoFiles } from '../photos/photos.js';
import { ApiError, validate } from './errors.js';
import { indexEvent, removeFromIndex } from '../search/index.js';
import { requireAuth } from './require-auth.js';

const fields = {
  type: z.enum(eventType.apiValues),
  type_description: z.string().trim().min(1).max(80).nullable(),
  title: z.string().trim().min(1, 'Enter the title.').max(160),
  subject_id: uuid.nullable(),
  date: dateOnly,
  reminder: z.enum(reminder.apiValues),
  notes: z.string().max(20000).nullable(),
  completed: z.boolean(),
};

export const createBody = z.object({
  id: uuid.optional(),
  type: fields.type,
  type_description: fields.type_description.optional(),
  title: fields.title,
  subject_id: fields.subject_id.optional(),
  date: fields.date,
  reminder: fields.reminder.default('none'),
  notes: fields.notes.optional(),
});

export const patchBody = z.object(fields).partial().strict();

export const listQuery = pageQuery.extend({
  start: dateOnly.optional(),
  end: dateOnly.optional(),
  type: z.enum(eventType.apiValues).optional(),
  subject_id: uuid.optional(),
  completed: z.enum(['true', 'false']).optional(),
  include_closed: z.enum(['true', 'false']).optional(),
});

function requireDescription(type: string, description: string | null | undefined): void {
  if (type === 'other' && !description) {
    throw new ApiError(422, 'validation', 'Some fields are invalid.', [
      { field: 'type_description', message: 'Describe the type of event.' },
    ]);
  }
}

export const eventRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const { pool, media } = ctx;
    app.addHook('preHandler', requireAuth(ctx));

    app.get('/events', async (req) => {
      const q = validate(listQuery, req.query);
      const where: string[] = ['usuario_id = ?'];
      const params: unknown[] = [req.userId];
      if (q.start) {
        where.push('data >= ?');
        params.push(q.start);
      }
      if (q.end) {
        where.push('data <= ?');
        params.push(q.end);
      }
      if (q.type) {
        where.push('tipo = ?');
        params.push(eventType.toDb(q.type));
      }
      if (q.subject_id) {
        where.push('materia_id = ?');
        params.push(q.subject_id);
      }
      if (q.completed) {
        where.push('concluido = ?');
        params.push(q.completed === 'true' ? 1 : 0);
      }
      if (q.include_closed !== 'true') where.push('encerrado_com_periodo = 0');

      const [count] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM evento WHERE ${where.join(' AND ')}`, params);
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT ${EVENT_COLUMNS} FROM evento WHERE ${where.join(' AND ')} ORDER BY data, criado_em LIMIT ? OFFSET ?`,
        [...params, q.limit, (q.page - 1) * q.limit],
      );
      return pageOf(rows.map(serializeEvent), q.page, q.limit, Number(count[0]?.n ?? 0));
    });

    app.post('/events', async (req, reply) => {
      const b = validate(createBody, req.body);
      requireDescription(b.type, b.type_description);
      await checkEventSubject(pool, req.userId, b.subject_id);
      const id = b.id ?? randomUUID();
      await pool.query(
        'INSERT INTO evento (id, usuario_id, materia_id, tipo, descricao_tipo, titulo, data, lembrete, anotacoes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          id,
          req.userId,
          b.subject_id ?? null,
          eventType.toDb(b.type),
          b.type === 'other' ? b.type_description : null,
          b.title,
          b.date,
          reminder.toDb(b.reminder),
          b.notes ?? null,
        ],
      );
      await indexEvent(pool, req.userId, id);
      return reply.status(201).send(serializeEvent(await findEvent(pool, req.userId, id)));
    });

    app.get<{ Params: { id: string } }>('/events/:id', async (req) => {
      const event = await findEvent(pool, req.userId, validate(uuid, req.params.id));
      return { ...serializeEvent(event), photos: await fetchPhotos(pool, req.userId, PHOTOS_OF_EVENT, [event.id]) };
    });

    app.patch<{ Params: { id: string } }>('/events/:id', async (req) => {
      const id = validate(uuid, req.params.id);
      const b = validate(patchBody, req.body);
      const current = await findEvent(pool, req.userId, id);

      // report delivery events belong to their report (docs/api.md, section 5): the date is changed there
      if (current.relatorio_id && (b.date !== undefined || b.type !== undefined || b.subject_id !== undefined)) {
        throw new ApiError(409, 'managed_by_report', 'This event is kept by its report. Change it in the report.');
      }
      // read-only when the subject's period is finished (also when the event is moved to such a subject)
      await checkEventSubject(pool, req.userId, current.materia_id as string | null);
      if (b.subject_id !== undefined) await checkEventSubject(pool, req.userId, b.subject_id);

      const type = b.type ?? eventType.toApi(current.tipo as string);
      const description = b.type_description !== undefined ? b.type_description : (current.descricao_tipo as string | null);
      requireDescription(type, description);

      const sets: string[] = [];
      const values: unknown[] = [];
      const set = (column: string, value: unknown) => {
        sets.push(`${column} = ?`);
        values.push(value);
      };
      if (b.type !== undefined || b.type_description !== undefined) {
        set('tipo', eventType.toDb(type as never));
        set('descricao_tipo', type === 'other' ? description : null);
      }
      if (b.title !== undefined) set('titulo', b.title);
      if (b.subject_id !== undefined) set('materia_id', b.subject_id);
      if (b.date !== undefined) set('data', b.date);
      if (b.reminder !== undefined) set('lembrete', reminder.toDb(b.reminder));
      if (b.notes !== undefined) set('anotacoes', b.notes);
      if (b.completed !== undefined) set('concluido', b.completed ? 1 : 0);

      if (sets.length)
        await pool.query(`UPDATE evento SET ${sets.join(', ')} WHERE usuario_id = ? AND id = ?`, [...values, req.userId, id]);
      await indexEvent(pool, req.userId, id);
      return serializeEvent(await findEvent(pool, req.userId, id));
    });

    app.delete<{ Params: { id: string } }>('/events/:id', async (req, reply) => {
      const id = validate(uuid, req.params.id);
      const current = await findEvent(pool, req.userId, id);
      if (current.relatorio_id) throw new ApiError(409, 'managed_by_report', 'This event is kept by its report. Change it in the report.');
      const files = await photoFiles(pool, req.userId, PHOTOS_OF_EVENT, [id]);
      await pool.query('DELETE FROM evento WHERE usuario_id = ? AND id = ?', [req.userId, id]);
      await removeFromIndex(pool, 'evento', [id]);
      await media.remove(files);
      return reply.status(204).send();
    });
  };
