import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import {
  cropCondition,
  dateOnly,
  inTransaction,
  irrigation,
  pageOf,
  pageQuery,
  pestLevel,
  deliveryFormat,
  reminder,
  reportStatus,
  reportType,
  uuid,
} from '../lib/common.js';
import { setTags, tagNames } from '../lib/tags.js';
import { AUDIOS_OF_REPORT, audioFiles } from '../audios/audios.js';
import { PHOTOS_OF_EVENT, PHOTOS_OF_REPORT, photoFiles } from '../photos/photos.js';
import { findActivePeriod } from '../periods/periods.js';
import { assertPeriodOpen, fetchReports, findReport, syncDeliveryEvent } from '../reports/reports.js';
import { checkEventSubject } from '../events/events.js';
import { ApiError, validate } from './errors.js';
import { indexReport, removeFromIndex } from '../search/index.js';
import { requireAuth } from './require-auth.js';

const area = z.object({
  crop: z.string().trim().max(80).nullable().optional(),
  place: z.string().trim().max(120).nullable().optional(),
  length_m: z.number().positive().max(99999999).nullable().optional(),
  width_m: z.number().positive().max(99999999).nullable().optional(),
});

export const createBody = z.object({
  id: uuid.optional(),
  title: z.string().trim().min(1, 'Enter the title.').max(160),
  subject_id: uuid,
  type: z.enum(reportType.apiValues),
  area: area.nullable().optional(),
  delivery_date: dateOnly.nullable().optional(),
  delivery_reminder: z.enum(reminder.apiValues).default('none'),
  delivery_format: z.enum(deliveryFormat.apiValues).nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
  tags: tagNames.optional(),
});

export const patchBody = z
  .object({
    title: z.string().trim().min(1).max(160),
    area: area.nullable(),
    delivery_date: dateOnly.nullable(),
    delivery_reminder: z.enum(reminder.apiValues),
    delivery_format: z.enum(deliveryFormat.apiValues).nullable(),
    notes: z.string().max(20000).nullable(),
    tags: tagNames,
    cover_photo_id: uuid.nullable(),
  })
  .partial()
  .strict();

export const listQuery = pageQuery.extend({
  status: z.enum(['in_progress', 'finished', 'all']).default('in_progress'),
  period_id: uuid.optional(),
  period: z.literal('all').optional(),
  subject_id: uuid.optional(),
  type: z.enum(reportType.apiValues).optional(),
  q: z.string().trim().min(1).max(100).optional(),
});

function fieldError(field: string, message: string): ApiError {
  return new ApiError(422, 'validation', 'Some fields are invalid.', [{ field, message }]);
}

export const reportRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const { pool, media } = ctx;
    app.addHook('preHandler', requireAuth(ctx));

    app.get('/reports', async (req) => {
      const q = validate(listQuery, req.query);
      const where: string[] = [];
      const params: unknown[] = [];
      if (q.status !== 'all') {
        where.push('r.status = ?');
        params.push(reportStatus.toDb(q.status));
      }
      if (q.period !== 'all') {
        const periodId = q.period_id ?? (await findActivePeriod(pool, req.userId))?.id ?? null;
        // without an active period (and no period asked) the default list is empty
        where.push('m.periodo_id <=> ?');
        params.push(periodId);
      }
      if (q.subject_id) {
        where.push('r.materia_id = ?');
        params.push(q.subject_id);
      }
      if (q.type) {
        where.push('r.tipo = ?');
        params.push(reportType.toDb(q.type));
      }
      if (q.q) {
        const like = `%${q.q.replace(/[\\%_]/g, '\\$&')}%`;
        where.push(`(r.titulo LIKE ? OR EXISTS (
            SELECT 1 FROM relatorio_tag l JOIN tag t ON t.usuario_id = l.usuario_id AND t.id = l.tag_id
             WHERE l.usuario_id = r.usuario_id AND l.relatorio_id = r.id AND t.nome LIKE ?)
          OR EXISTS (
            SELECT 1 FROM registro g WHERE g.usuario_id = r.usuario_id AND g.relatorio_id = r.id
               AND (g.praga_nome LIKE ? OR g.observacoes LIKE ? OR g.aplicacao_produto LIKE ?)))`);
        params.push(like, like, like, like, like);
      }
      const filter = { sql: where.length ? where.join(' AND ') : '1 = 1', params };
      const [count] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM relatorio r JOIN materia m ON m.usuario_id = r.usuario_id AND m.id = r.materia_id WHERE r.usuario_id = ? AND ${filter.sql}`,
        [req.userId, ...params],
      );
      const items = await fetchReports(pool, req.userId, filter, { limit: q.limit, offset: (q.page - 1) * q.limit });
      return pageOf(items, q.page, q.limit, Number(count[0]?.n ?? 0));
    });

    app.post('/reports', async (req, reply) => {
      const b = validate(createBody, req.body);
      if (b.type === 'one_off' && b.area) throw fieldError('area', 'Only continuous reports have an area.');
      const id = b.id ?? randomUUID();
      await inTransaction(pool, async (tx) => {
        await checkEventSubject(tx, req.userId, b.subject_id); // own subject, active period
        await tx.query(
          `INSERT INTO relatorio (id, usuario_id, materia_id, titulo, tipo, data_entrega, lembrete_entrega, formato_entrega, observacoes,
                                  area_cultura, area_local, area_comprimento_m, area_largura_m)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            req.userId,
            b.subject_id,
            b.title,
            reportType.toDb(b.type),
            b.delivery_date ?? null,
            reminder.toDb(b.delivery_reminder),
            b.delivery_format ? deliveryFormat.toDb(b.delivery_format) : null,
            b.notes ?? null,
            b.area?.crop ?? null,
            b.area?.place ?? null,
            b.area?.length_m ?? null,
            b.area?.width_m ?? null,
          ],
        );
        await syncDeliveryEvent(
          tx,
          req.userId,
          { id, title: b.title, subjectId: b.subject_id },
          b.delivery_date ?? null,
          b.delivery_reminder,
        );
        if (b.tags) await setTags(tx, req.userId, { table: 'relatorio_tag', owner: 'relatorio_id' }, id, b.tags, false); // new item: no version bump
        await indexReport(tx, req.userId, id);
      });
      return reply.status(201).send(await detail(req.userId, id));
    });

    /** Report + current situation (latest completed entry) + open "next visit" items. */
    async function detail(userId: string, id: string) {
      const { subject_period_status, ...report } = await findReport(pool, userId, id);
      void subject_period_status;
      const [latest] = await pool.query<RowDataPacket[]>(
        `SELECT cultura_estado, estagio, irrigacao, houve_praga, praga_nome, praga_nivel FROM registro
          WHERE usuario_id = ? AND relatorio_id = ? AND status = 'concluido' ORDER BY data_hora DESC LIMIT 1`,
        [userId, id],
      );
      const l = latest[0];
      const [todos] = await pool.query<RowDataPacket[]>(
        `SELECT p.id, p.texto, p.registro_id FROM registro_pendencia p JOIN registro g ON g.usuario_id = p.usuario_id AND g.id = p.registro_id
          WHERE p.usuario_id = ? AND g.relatorio_id = ? AND p.feito = 0 ORDER BY g.data_hora, p.ordem`,
        [userId, id],
      );
      return {
        ...report,
        current_situation: l
          ? {
              crop_condition: l.cultura_estado ? cropCondition.toApi(l.cultura_estado as string) : null,
              stage: (l.estagio as string | null) ?? null,
              irrigation: l.irrigacao ? irrigation.toApi(l.irrigacao as string) : null,
              pest:
                l.houve_praga === 1
                  ? { name: l.praga_nome as string, level: l.praga_nivel ? pestLevel.toApi(l.praga_nivel as string) : null }
                  : null,
            }
          : null,
        open_todos: todos.map((t) => ({ id: t.id as string, text: t.texto as string, entry_id: t.registro_id as string })),
      };
    }

    app.get<{ Params: { id: string } }>('/reports/:id', async (req) => detail(req.userId, validate(uuid, req.params.id)));

    app.patch<{ Params: { id: string } }>('/reports/:id', async (req) => {
      const id = validate(uuid, req.params.id);
      const b = validate(patchBody, req.body);
      const current = await findReport(pool, req.userId, id);
      assertPeriodOpen(current);
      if (b.area && current.type === 'one_off') throw fieldError('area', 'Only continuous reports have an area.');

      // removing the delivery date removes its event, and the event's photos go with it
      let eventFiles: string[] = [];
      if (b.delivery_date === null && current.delivery_event_id) {
        eventFiles = await photoFiles(pool, req.userId, PHOTOS_OF_EVENT, [current.delivery_event_id]);
      }
      await inTransaction(pool, async (tx) => {
        const sets: string[] = [];
        const values: unknown[] = [];
        const set = (column: string, value: unknown) => {
          sets.push(`${column} = ?`);
          values.push(value);
        };
        if (b.title !== undefined) set('titulo', b.title);
        if (b.notes !== undefined) set('observacoes', b.notes);
        if (b.delivery_date !== undefined) set('data_entrega', b.delivery_date);
        if (b.delivery_reminder !== undefined) set('lembrete_entrega', reminder.toDb(b.delivery_reminder));
        if (b.delivery_format !== undefined) set('formato_entrega', b.delivery_format ? deliveryFormat.toDb(b.delivery_format) : null);
        if (b.area !== undefined) {
          set('area_cultura', b.area?.crop ?? null);
          set('area_local', b.area?.place ?? null);
          set('area_comprimento_m', b.area?.length_m ?? null);
          set('area_largura_m', b.area?.width_m ?? null);
        }
        if (b.cover_photo_id !== undefined) {
          if (b.cover_photo_id !== null) {
            // only a photo of this report (its area or one of its entries) can be the cover
            const [own] = await tx.query<RowDataPacket[]>(
              'SELECT f.id FROM foto f LEFT JOIN registro g ON g.usuario_id = f.usuario_id AND g.id = f.registro_id WHERE f.usuario_id = ? AND f.id = ? AND (f.relatorio_id = ? OR g.relatorio_id = ?)',
              [req.userId, b.cover_photo_id, id, id],
            );
            if (!own[0]) throw fieldError('cover_photo_id', 'Choose a photo of this report.');
          }
          set('capa_foto_id', b.cover_photo_id);
        }
        if (sets.length)
          await tx.query(`UPDATE relatorio SET ${sets.join(', ')} WHERE usuario_id = ? AND id = ?`, [...values, req.userId, id]);
        if (b.tags) await setTags(tx, req.userId, { table: 'relatorio_tag', owner: 'relatorio_id' }, id, b.tags);
        await indexReport(tx, req.userId, id);

        if (b.title !== undefined || b.delivery_date !== undefined || b.delivery_reminder !== undefined) {
          await syncDeliveryEvent(
            tx,
            req.userId,
            { id, title: b.title ?? current.title, subjectId: current.subject.id },
            b.delivery_date !== undefined ? b.delivery_date : current.delivery_date,
            b.delivery_reminder ?? current.delivery_reminder,
          );
        }
      });
      await media.remove(eventFiles);
      return detail(req.userId, id);
    });

    // Deletes the report, its entries (cascade), their to-do items and the delivery event.
    app.delete<{ Params: { id: string } }>('/reports/:id', async (req, reply) => {
      const id = validate(uuid, req.params.id);
      assertPeriodOpen(await findReport(pool, req.userId, id));
      const files = [
        ...(await photoFiles(pool, req.userId, PHOTOS_OF_REPORT, [id, id, id])),
        ...(await audioFiles(pool, req.userId, AUDIOS_OF_REPORT, [id])),
      ];
      const [entryIds] = await pool.query<RowDataPacket[]>('SELECT id FROM registro WHERE usuario_id = ? AND relatorio_id = ?', [
        req.userId,
        id,
      ]);
      const [eventIds] = await pool.query<RowDataPacket[]>('SELECT id FROM evento WHERE usuario_id = ? AND relatorio_id = ?', [
        req.userId,
        id,
      ]);
      await pool.query('DELETE FROM relatorio WHERE usuario_id = ? AND id = ?', [req.userId, id]);
      await removeFromIndex(pool, 'relatorio', [id]);
      await removeFromIndex(
        pool,
        'registro',
        entryIds.map((r) => r.id as string),
      );
      await removeFromIndex(
        pool,
        'evento',
        eventIds.map((r) => r.id as string),
      );
      await media.remove(files);
      return reply.status(204).send();
    });

    app.post<{ Params: { id: string } }>('/reports/:id/finish', async (req) => {
      const id = validate(uuid, req.params.id);
      const report = await findReport(pool, req.userId, id);
      assertPeriodOpen(report);
      if (report.status === 'finished') throw new ApiError(409, 'report_finished', 'This report is already finished.');
      await pool.query(
        "UPDATE relatorio SET status = 'finalizado', finalizado_em = NOW(3), finalizado_por = 'usuario' WHERE usuario_id = ? AND id = ?",
        [req.userId, id],
      );
      const [drafts] = await pool.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS n FROM registro WHERE usuario_id = ? AND relatorio_id = ? AND status = 'rascunho'",
        [req.userId, id],
      );
      const draftEntries = Number(drafts[0]?.n ?? 0);
      return { ...(await detail(req.userId, id)), ...(draftEntries > 0 ? { warning: { draft_entries: draftEntries } } : {}) };
    });

    app.post<{ Params: { id: string } }>('/reports/:id/reopen', async (req) => {
      const id = validate(uuid, req.params.id);
      const report = await findReport(pool, req.userId, id);
      assertPeriodOpen(report);
      if (report.status !== 'finished') throw new ApiError(409, 'report_not_finished', 'This report is not finished.');
      await pool.query(
        "UPDATE relatorio SET status = 'em_andamento', finalizado_em = NULL, finalizado_por = NULL WHERE usuario_id = ? AND id = ?",
        [req.userId, id],
      );
      return detail(req.userId, id);
    });
  };
