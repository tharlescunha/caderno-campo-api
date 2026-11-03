import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { classType, eventType, inTransaction, pageOf, pageQuery, subjectColor, todayFor, uuid, type Db } from '../lib/common.js';
import { findActivePeriod, findPeriod } from '../periods/periods.js';
import { checkTeacher, fetchSubjects, findSubject, replaceWeekdays } from '../subjects/subjects.js';
import { ApiError, validate } from './errors.js';
import { indexSubject, removeFromIndex } from '../search/index.js';
import { requireAuth } from './require-auth.js';

const weekdays = z.array(z.number().int().min(1).max(7)).min(1, 'Choose at least one day.').max(7);

export const createBody = z.object({
  id: uuid.optional(),
  period_id: uuid.optional(),
  name: z.string().trim().min(1, 'Enter the name.').max(120),
  teacher_id: uuid.nullable().optional(),
  class_type: z.enum(classType.apiValues).default('classroom'),
  weekdays,
  color: z.enum(subjectColor.apiValues).default('green'),
  remind_eve: z.boolean().default(true),
});

export const patchBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    teacher_id: uuid.nullable(),
    class_type: z.enum(classType.apiValues),
    weekdays,
    color: z.enum(subjectColor.apiValues),
    remind_eve: z.boolean(),
    deactivated: z.boolean(),
  })
  .partial()
  .strict();

export const listQuery = pageQuery.extend({ period_id: uuid.optional(), period: z.literal('all').optional() });
export const copyBody = z.object({ id: uuid.optional(), period_id: uuid });

export const subjectRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const { pool } = ctx;
    app.addHook('preHandler', requireAuth(ctx));

    /** A new subject can only go into an active period of the user. */
    async function activePeriodFor(db: Db, userId: string, periodId: string | undefined): Promise<string> {
      if (!periodId) {
        const active = await findActivePeriod(db, userId);
        if (!active) throw new ApiError(409, 'no_active_period', 'Register your period to start.');
        return active.id as string;
      }
      const period = await findPeriod(db, userId, periodId);
      if (period.status !== 'ativo') throw new ApiError(409, 'period_finished', 'Finished periods are read-only.');
      return period.id as string;
    }

    /** Subject of the user + its period must still be active to be changed. */
    async function editableSubject(db: Db, userId: string, id: string, today: string) {
      const subject = await findSubject(db, userId, today, id);
      const period = await findPeriod(db, userId, subject.period_id);
      if (period.status !== 'ativo') throw new ApiError(409, 'period_finished', 'Finished periods are read-only.');
      return subject;
    }

    async function insertSubject(
      tx: PoolConnection,
      userId: string,
      v: {
        id: string;
        periodId: string;
        name: string;
        teacherId: string | null;
        classType: string;
        color: string;
        remindEve: boolean;
        weekdays: number[];
      },
    ) {
      await tx.query(
        'INSERT INTO materia (id, usuario_id, periodo_id, professor_id, nome, tipo_aula, cor, lembrar_vespera) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          v.id,
          userId,
          v.periodId,
          v.teacherId,
          v.name,
          classType.toDb(v.classType as never),
          subjectColor.toDb(v.color as never),
          v.remindEve ? 1 : 0,
        ],
      );
      await replaceWeekdays(tx, v.id, v.weekdays);
      await indexSubject(tx, userId, v.id);
    }

    app.get('/subjects', async (req) => {
      const q = validate(listQuery, req.query);
      const today = await todayFor(pool, req.userId);
      let filter: { sql: string; params: unknown[] };
      if (q.period === 'all') filter = { sql: '1 = 1', params: [] };
      else if (q.period_id) filter = { sql: 'm.periodo_id = ?', params: [q.period_id] };
      else {
        const active = await findActivePeriod(pool, req.userId);
        // without an active period the list is empty
        filter = active ? { sql: 'm.periodo_id = ?', params: [active.id] } : { sql: '1 = 0', params: [] };
      }
      const [count] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM materia m WHERE m.usuario_id = ? AND ${filter.sql}`, [
        req.userId,
        ...filter.params,
      ]);
      const items = await fetchSubjects(pool, req.userId, today, filter, { limit: q.limit, offset: (q.page - 1) * q.limit });
      return pageOf(items, q.page, q.limit, Number(count[0]?.n ?? 0));
    });

    // Always days 1 to 6 (and 7 only when it has a subject). Deactivated subjects are left out.
    app.get('/subjects/weekly-board', async (req) => {
      const today = await todayFor(pool, req.userId);
      const active = await findActivePeriod(pool, req.userId);
      const items = active
        ? await fetchSubjects(pool, req.userId, today, { sql: 'm.periodo_id = ? AND m.desativada = 0', params: [active.id] })
        : [];
      const last = items.some((s) => s.weekdays.includes(7)) ? 7 : 6;
      return {
        days: Array.from({ length: last }, (_, i) => ({
          weekday: i + 1,
          subjects: items
            .filter((s) => s.weekdays.includes(i + 1))
            .map((s) => ({ id: s.id, name: s.name, color: s.color, class_type: s.class_type, teacher: s.teacher?.name ?? null })),
        })),
      };
    });

    app.post('/subjects', async (req, reply) => {
      const b = validate(createBody, req.body);
      const today = await todayFor(pool, req.userId);
      const id = b.id ?? randomUUID();
      await inTransaction(pool, async (tx) => {
        const periodId = await activePeriodFor(tx, req.userId, b.period_id);
        await checkTeacher(tx, req.userId, b.teacher_id);
        await insertSubject(tx, req.userId, {
          id,
          periodId,
          name: b.name,
          teacherId: b.teacher_id ?? null,
          classType: b.class_type,
          color: b.color,
          remindEve: b.remind_eve,
          weekdays: [...new Set(b.weekdays)],
        });
      });
      return reply.status(201).send(await findSubject(pool, req.userId, today, id));
    });

    app.get<{ Params: { id: string } }>('/subjects/:id', async (req) => {
      const id = validate(uuid, req.params.id);
      const today = await todayFor(pool, req.userId);
      const subject = await findSubject(pool, req.userId, today, id);
      const [events] = await pool.query<RowDataPacket[]>(
        `SELECT id, tipo, titulo, data FROM evento
          WHERE usuario_id = ? AND materia_id = ? AND data >= ? AND encerrado_com_periodo = 0 ORDER BY data`,
        [req.userId, id, today],
      );
      const [reports] = await pool.query<RowDataPacket[]>(
        'SELECT id, titulo, tipo, status FROM relatorio WHERE usuario_id = ? AND materia_id = ? ORDER BY criado_em DESC LIMIT 3',
        [req.userId, id],
      );
      const [notes] = await pool.query<RowDataPacket[]>(
        'SELECT id, titulo, fixada FROM anotacao WHERE usuario_id = ? AND materia_id = ? ORDER BY fixada DESC, atualizado_em DESC LIMIT 5',
        [req.userId, id],
      );
      return {
        ...subject,
        upcoming_events: events.map((e) => ({
          id: e.id as string,
          type: eventType.toApi(e.tipo as string),
          title: e.titulo as string,
          date: e.data as string,
        })),
        reports: reports.map((r) => ({
          id: r.id as string,
          title: r.titulo as string,
          type: r.tipo === 'continuo' ? 'continuous' : 'one_off',
          status: r.status === 'em_andamento' ? 'in_progress' : 'finished',
        })),
        notes: notes.map((n) => ({ id: n.id as string, title: n.titulo as string, pinned: n.fixada === 1 })),
      };
    });

    app.patch<{ Params: { id: string } }>('/subjects/:id', async (req) => {
      const id = validate(uuid, req.params.id);
      const b = validate(patchBody, req.body);
      const today = await todayFor(pool, req.userId);
      await inTransaction(pool, async (tx) => {
        await editableSubject(tx, req.userId, id, today);
        await checkTeacher(tx, req.userId, b.teacher_id);
        const sets: string[] = [];
        const values: unknown[] = [];
        if (b.name !== undefined) {
          sets.push('nome = ?');
          values.push(b.name);
        }
        if (b.teacher_id !== undefined) {
          sets.push('professor_id = ?');
          values.push(b.teacher_id);
        }
        if (b.class_type !== undefined) {
          sets.push('tipo_aula = ?');
          values.push(classType.toDb(b.class_type));
        }
        if (b.color !== undefined) {
          sets.push('cor = ?');
          values.push(subjectColor.toDb(b.color));
        }
        if (b.remind_eve !== undefined) {
          sets.push('lembrar_vespera = ?');
          values.push(b.remind_eve ? 1 : 0);
        }
        if (b.deactivated !== undefined) {
          sets.push('desativada = ?');
          values.push(b.deactivated ? 1 : 0);
        }
        if (b.weekdays !== undefined) {
          await replaceWeekdays(tx, id, [...new Set(b.weekdays)]);
          if (!sets.length) sets.push('nome = nome'); // touch the row so `versao` goes up
        }
        if (sets.length)
          await tx.query(`UPDATE materia SET ${sets.join(', ')} WHERE usuario_id = ? AND id = ?`, [...values, req.userId, id]);
        await indexSubject(tx, req.userId, id);
      });
      return findSubject(pool, req.userId, today, id);
    });

    // The user dropped the subject mid-period: it leaves the screens, the data stays.
    app.post<{ Params: { id: string } }>('/subjects/:id/deactivate', async (req) => {
      const id = validate(uuid, req.params.id);
      const today = await todayFor(pool, req.userId);
      await editableSubject(pool, req.userId, id, today);
      await pool.query('UPDATE materia SET desativada = 1 WHERE usuario_id = ? AND id = ?', [req.userId, id]);
      return findSubject(pool, req.userId, today, id);
    });

    app.post<{ Params: { id: string } }>('/subjects/:id/reactivate', async (req) => {
      const id = validate(uuid, req.params.id);
      const today = await todayFor(pool, req.userId);
      await editableSubject(pool, req.userId, id, today);
      await pool.query('UPDATE materia SET desativada = 0 WHERE usuario_id = ? AND id = ?', [req.userId, id]);
      return findSubject(pool, req.userId, today, id);
    });

    // Copies name, teacher, type, weekdays and color to another (active) period; no reports, notes or events.
    app.post<{ Params: { id: string } }>('/subjects/:id/copy', async (req, reply) => {
      const id = validate(uuid, req.params.id);
      const b = validate(copyBody, req.body);
      const today = await todayFor(pool, req.userId);
      const newId = b.id ?? randomUUID();
      await inTransaction(pool, async (tx) => {
        const source = await findSubject(tx, req.userId, today, id);
        const periodId = await activePeriodFor(tx, req.userId, b.period_id);
        await insertSubject(tx, req.userId, {
          id: newId,
          periodId,
          name: source.name,
          teacherId: source.teacher?.id ?? null,
          classType: source.class_type,
          color: source.color,
          remindEve: source.remind_eve,
          weekdays: source.weekdays,
        });
      });
      return reply.status(201).send(await findSubject(pool, req.userId, today, newId));
    });

    app.delete<{ Params: { id: string } }>('/subjects/:id', async (req, reply) => {
      const id = validate(uuid, req.params.id);
      const today = await todayFor(pool, req.userId);
      const subject = await editableSubject(pool, req.userId, id, today);
      const [events] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM evento WHERE usuario_id = ? AND materia_id = ?', [
        req.userId,
        id,
      ]);
      const counts = { reports: subject.totals.reports, notes: subject.totals.notes, events: Number(events[0]?.n ?? 0) };
      if (counts.reports + counts.notes + counts.events > 0) {
        throw new ApiError(409, 'subject_has_data', 'This subject has linked data. Deactivate it instead.', undefined, counts);
      }
      await pool.query('DELETE FROM materia WHERE usuario_id = ? AND id = ?', [req.userId, id]);
      await removeFromIndex(pool, 'materia', [id]);
      return reply.status(204).send();
    });
  };
