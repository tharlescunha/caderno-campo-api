import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { dateOnly, inTransaction, pageOf, pageQuery, todayFor, uuid } from '../lib/common.js';
import { closePeriod, closingPreview, findActivePeriod, findPeriod, PERIOD_COLUMNS, serializePeriod } from '../periods/periods.js';
import { ApiError, validate } from './errors.js';
import { requireAuth } from './require-auth.js';

export const createBody = z.object({
  id: uuid.optional(),
  name: z.string().trim().min(1, 'Enter the name.').max(80),
  start_date: dateOnly,
  end_date: dateOnly.nullable().optional(),
  confirm_closing: z.boolean().optional(),
});

export const patchBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    start_date: dateOnly,
    end_date: dateOnly.nullable(),
  })
  .partial()
  .strict();

function checkDates(start: string, end: string | null | undefined): void {
  if (end && end < start) {
    throw new ApiError(422, 'validation', 'Some fields are invalid.', [
      { field: 'end_date', message: 'The end date cannot be before the start date.' },
    ]);
  }
}

export const periodRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const { pool } = ctx;
    app.addHook('preHandler', requireAuth(ctx));

    const totalsSql = `
      (SELECT COUNT(*) FROM materia m WHERE m.usuario_id = p.usuario_id AND m.periodo_id = p.id) AS n_subjects,
      (SELECT COUNT(*) FROM relatorio r JOIN materia m ON m.usuario_id = r.usuario_id AND m.id = r.materia_id
        WHERE r.usuario_id = p.usuario_id AND m.periodo_id = p.id) AS n_reports,
      (SELECT COUNT(*) FROM anotacao a JOIN materia m ON m.usuario_id = a.usuario_id AND m.id = a.materia_id
        WHERE a.usuario_id = p.usuario_id AND m.periodo_id = p.id) AS n_notes`;

    async function withTotals(userId: string, where: string, params: unknown[], paging?: { limit: number; offset: number }) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT ${PERIOD_COLUMNS.split(', ')
          .map((c) => `p.${c}`)
          .join(', ')}, ${totalsSql}
           FROM periodo p WHERE p.usuario_id = ? ${where} ORDER BY p.data_inicio DESC${paging ? ' LIMIT ? OFFSET ?' : ''}`,
        [userId, ...params, ...(paging ? [paging.limit, paging.offset] : [])],
      );
      return rows.map((r) => ({
        ...serializePeriod(r),
        totals: { subjects: Number(r.n_subjects), reports: Number(r.n_reports), notes: Number(r.n_notes) },
      }));
    }

    app.get('/periods', async (req) => {
      const { page, limit } = validate(pageQuery, req.query);
      const [count] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM periodo WHERE usuario_id = ?', [req.userId]);
      const items = await withTotals(req.userId, '', [], { limit, offset: (page - 1) * limit });
      return pageOf(items, page, limit, Number(count[0]?.n ?? 0));
    });

    app.get('/periods/active', async (req) => {
      const [item] = await withTotals(req.userId, "AND p.status = 'ativo'", []);
      if (!item) throw new ApiError(404, 'not_found', 'No active period.');
      return item;
    });

    app.get<{ Params: { id: string } }>('/periods/:id', async (req) => {
      const id = validate(uuid, req.params.id);
      const [item] = await withTotals(req.userId, 'AND p.id = ?', [id]);
      if (!item) throw new ApiError(404, 'not_found', 'Period not found.');
      const [subjects] = await pool.query<RowDataPacket[]>(
        'SELECT id, nome, cor, desativada FROM materia WHERE usuario_id = ? AND periodo_id = ? ORDER BY nome',
        [req.userId, id],
      );
      return {
        ...item,
        subjects: subjects.map((s) => ({ id: s.id as string, name: s.nome as string, deactivated: s.desativada === 1 })),
      };
    });

    app.get<{ Params: { id: string } }>('/periods/:id/closing-preview', async (req) => {
      const period = await findPeriod(pool, req.userId, validate(uuid, req.params.id));
      return closingPreview(pool, req.userId, period, await todayFor(pool, req.userId));
    });

    // Creates and activates; closes the current one when confirmed (single transaction).
    app.post('/periods', async (req, reply) => {
      const b = validate(createBody, req.body);
      checkDates(b.start_date, b.end_date);
      const today = await todayFor(pool, req.userId);

      const created = await inTransaction(pool, async (tx) => {
        const active = await findActivePeriod(tx, req.userId);
        if (active) {
          if (b.confirm_closing !== true) {
            const preview = await closingPreview(tx, req.userId, active, today);
            throw new ApiError(
              409,
              'closing_required',
              'Creating a new period closes the current one. Confirm to continue.',
              undefined,
              preview,
            );
          }
          await closePeriod(tx, req.userId, active.id as string, today);
        }
        const id = b.id ?? randomUUID();
        await tx.query("INSERT INTO periodo (id, usuario_id, nome, data_inicio, data_fim, status) VALUES (?, ?, ?, ?, ?, 'ativo')", [
          id,
          req.userId,
          b.name,
          b.start_date,
          b.end_date ?? null,
        ]);
        return id;
      });
      const [item] = await withTotals(req.userId, 'AND p.id = ?', [created]);
      return reply.status(201).send(item);
    });

    // Closes the period without creating another one.
    app.post<{ Params: { id: string } }>('/periods/:id/close', async (req) => {
      const id = validate(uuid, req.params.id);
      const today = await todayFor(pool, req.userId);
      await inTransaction(pool, async (tx) => {
        const period = await findPeriod(tx, req.userId, id, true);
        if (period.status !== 'ativo') throw new ApiError(409, 'period_finished', 'This period is already finished.');
        await closePeriod(tx, req.userId, id, today);
      });
      const [item] = await withTotals(req.userId, 'AND p.id = ?', [id]);
      return item;
    });

    app.patch<{ Params: { id: string } }>('/periods/:id', async (req) => {
      const id = validate(uuid, req.params.id);
      const b = validate(patchBody, req.body);
      const period = await findPeriod(pool, req.userId, id);
      if (period.status !== 'ativo') throw new ApiError(409, 'period_finished', 'Finished periods are read-only.');
      checkDates(
        b.start_date ?? (period.data_inicio as string),
        b.end_date !== undefined ? b.end_date : (period.data_fim as string | null),
      );

      const sets: string[] = [];
      const values: unknown[] = [];
      if (b.name !== undefined) {
        sets.push('nome = ?');
        values.push(b.name);
      }
      if (b.start_date !== undefined) {
        sets.push('data_inicio = ?');
        values.push(b.start_date);
      }
      if (b.end_date !== undefined) {
        sets.push('data_fim = ?');
        values.push(b.end_date);
      }
      if (sets.length)
        await pool.query(`UPDATE periodo SET ${sets.join(', ')} WHERE usuario_id = ? AND id = ?`, [...values, req.userId, id]);
      const [item] = await withTotals(req.userId, 'AND p.id = ?', [id]);
      return item;
    });

    app.delete<{ Params: { id: string } }>('/periods/:id', async (req, reply) => {
      const id = validate(uuid, req.params.id);
      await findPeriod(pool, req.userId, id);
      const [count] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM materia WHERE usuario_id = ? AND periodo_id = ?', [
        req.userId,
        id,
      ]);
      const subjects = Number(count[0]?.n ?? 0);
      if (subjects > 0) throw new ApiError(409, 'period_has_subjects', 'This period has subjects.', undefined, { subjects });
      await pool.query('DELETE FROM periodo WHERE usuario_id = ? AND id = ?', [req.userId, id]);
      return reply.status(204).send();
    });
  };
