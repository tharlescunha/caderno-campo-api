import type { FastifyPluginAsync } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { dateOnly, eventType, todayFor } from '../lib/common.js';
import { findActivePeriod } from '../periods/periods.js';
import { fetchSubjects } from '../subjects/subjects.js';
import { ApiError, validate } from './errors.js';
import { requireAuth } from './require-auth.js';

const MAX_DAYS = 42;
const CHIPS = ['class', 'field', 'exam', 'delivery', 'other'] as const;

export const query = z.object({
  start: dateOnly,
  end: dateOnly,
  // filter chips of the screen, comma separated: class,field,exam,delivery,other
  type: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()) : null))
    .pipe(z.array(z.enum(CHIPS)).nullable()),
});

const DELIVERY = ['report_delivery', 'assignment'];
const OTHER = ['activity', 'college_event', 'other'];

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
function isoWeekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

export const agendaRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const { pool } = ctx;
    app.addHook('preHandler', requireAuth(ctx));

    // Fixed weekly subjects (active period) plus the events of the range.
    app.get('/agenda', async (req) => {
      const q = validate(query, req.query);
      if (q.end < q.start)
        throw new ApiError(422, 'validation', 'Some fields are invalid.', [
          { field: 'end', message: 'The end cannot be before the start.' },
        ]);
      if (q.end > addDays(q.start, MAX_DAYS - 1)) {
        throw new ApiError(422, 'validation', 'Some fields are invalid.', [
          { field: 'end', message: `The range is at most ${MAX_DAYS} days.` },
        ]);
      }

      const today = await todayFor(pool, req.userId);
      const active = await findActivePeriod(pool, req.userId);
      const wants = (chip: (typeof CHIPS)[number]) => q.type === null || q.type.includes(chip);

      const subjects = active
        ? (await fetchSubjects(pool, req.userId, today, { sql: 'm.periodo_id = ? AND m.desativada = 0', params: [active.id] })).filter(
            (s) => (wants('class') && s.class_type !== 'field') || (wants('field') && s.class_type !== 'classroom'),
          )
        : [];

      // events of the active period's subjects, plus events without a subject; never the ones closed with a period
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT e.id, e.tipo, e.titulo, e.materia_id, e.concluido, e.data
           FROM evento e
          WHERE e.usuario_id = ? AND e.data BETWEEN ? AND ? AND e.encerrado_com_periodo = 0
            AND (e.materia_id IS NULL OR e.materia_id IN (SELECT id FROM materia WHERE usuario_id = ? AND periodo_id <=> ?))
          ORDER BY e.data, e.criado_em`,
        [req.userId, q.start, q.end, req.userId, active?.id ?? null],
      );
      const events = rows
        .map((r) => ({
          date: r.data as string,
          id: r.id as string,
          type: eventType.toApi(r.tipo as string),
          title: r.titulo as string,
          subject_id: (r.materia_id as string | null) ?? null,
          completed: r.concluido === 1,
        }))
        .filter((e) =>
          q.type === null
            ? true
            : (wants('exam') && e.type === 'exam') ||
              (wants('delivery') && DELIVERY.includes(e.type)) ||
              (wants('other') && OTHER.includes(e.type)),
        );

      const days = [];
      for (let date = q.start; date <= q.end; date = addDays(date, 1)) {
        const weekday = isoWeekday(date);
        days.push({
          date,
          weekday,
          subjects: subjects
            .filter((s) => s.weekdays.includes(weekday))
            .map((s) => ({ id: s.id, name: s.name, color: s.color, class_type: s.class_type, teacher: s.teacher?.name ?? null })),
          events: events
            .filter((e) => e.date === date)
            .map((e) => ({ id: e.id, type: e.type, title: e.title, subject_id: e.subject_id, completed: e.completed })),
        });
      }
      return { start: q.start, end: q.end, days };
    });
  };
