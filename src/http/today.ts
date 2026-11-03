import type { FastifyPluginAsync } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { dateOnly, eventType } from '../lib/common.js';
import { addDays, daysBetween, isoWeekday, localDate, zonedToUtc } from '../lib/time.js';
import { findActivePeriod } from '../periods/periods.js';
import { fetchSubjects, type SubjectItem } from '../subjects/subjects.js';
import { isoDate } from '../users/user.js';
import { ApiError, validate } from './errors.js';
import { countUnread } from './notifications.js';
import { requireAuth } from './require-auth.js';

export const query = z.object({
  date: dateOnly.optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
});

const PENDING_DAYS = 7;
const UPCOMING_DAYS = 14;
const UPCOMING_MAX = 5;
const RECENT_MAX = 5;
const NO_PHOTO_DAYS = 14;

const brief = (s: SubjectItem) => ({ id: s.id, name: s.name, color: s.color, class_type: s.class_type, teacher: s.teacher });
const fieldClass = (s: SubjectItem) => s.class_type !== 'classroom';

export const todayRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const { pool, market } = ctx;
    app.addHook('preHandler', requireAuth(ctx));

    // One call builds the whole Today screen. Everything refers to the active period.
    app.get('/today', async (req) => {
      const q = validate(query, req.query);
      if ((q.lat === undefined) !== (q.lon === undefined)) {
        throw new ApiError(422, 'validation', 'Some fields are invalid.', [{ field: 'lon', message: 'Send lat and lon together.' }]);
      }
      const userId = req.userId;
      const [users] = await pool.query<RowDataPacket[]>(
        'SELECT fuso_horario, cidade_cotacoes, latitude_padrao, longitude_padrao FROM usuario WHERE id = ?',
        [userId],
      );
      const tz = users[0]!.fuso_horario as string;
      const date = q.date ?? localDate(new Date(), tz);
      const tomorrow = addDays(date, 1);
      const period = await findActivePeriod(pool, userId);
      const spot =
        q.lat !== undefined && q.lon !== undefined
          ? { latitude: q.lat, longitude: q.lon }
          : users[0]!.latitude_padrao == null
            ? market?.defaultLocation
            : { latitude: Number(users[0]!.latitude_padrao), longitude: Number(users[0]!.longitude_padrao) };

      // ---- classes ----
      const subjects = period
        ? await fetchSubjects(pool, userId, date, { sql: 'm.periodo_id = ? AND m.desativada = 0', params: [period.id] })
        : [];
      const onDay = (day: string) => subjects.filter((s) => s.weekdays.includes(isoWeekday(day)));
      const todays = onDay(date);
      const dayStart = zonedToUtc(date, '00:00', tz);
      const dayEnd = zonedToUtc(tomorrow, '00:00', tz);

      let subjectToday = null;
      if (todays[0]) {
        const [notes] = await pool.query<RowDataPacket[]>(
          'SELECT COUNT(*) AS total, SUM(criado_em >= ? AND criado_em < ?) AS today FROM anotacao WHERE usuario_id = ? AND materia_id = ?',
          [dayStart, dayEnd, userId, todays[0].id],
        );
        subjectToday = {
          ...brief(todays[0]),
          notes_this_class: Number(notes[0]?.today ?? 0),
          notes_in_subject: Number(notes[0]?.total ?? 0),
        };
      }

      // ---- market (cache) and the forecast of tomorrow ----
      const [quotesBlock, dollarBlock, weatherBlock, newsBlock] = market
        ? await Promise.all([
            market.quotes(users[0]!.cidade_cotacoes as string),
            market.dollar(),
            spot ? market.weather(spot.latitude, spot.longitude) : Promise.resolve(null),
            market.news(),
          ])
        : [null, null, null, null];
      const weather = weatherBlock?.value ?? null;
      const forecastOf = (day: string) => {
        const f = weather?.forecast_days.find((d) => d.date === day);
        return f ? { min_c: Math.round(f.min), max_c: Math.round(f.max), rain_chance_pct: f.rain_chance_pct } : null;
      };

      const tomorrows = onDay(tomorrow);
      const tomorrowBlock = {
        date: tomorrow,
        subject: tomorrows[0] ? brief(tomorrows[0]) : null,
        subjects: tomorrows.map(brief),
        forecast: tomorrows.length ? forecastOf(tomorrow) : null,
      };

      // ---- pending, by urgency ----
      const pending: Record<string, unknown>[] = [];
      if (period) {
        const [reports] = await pool.query<RowDataPacket[]>(
          `SELECT r.id, r.titulo, r.data_entrega, m.nome AS subject FROM relatorio r JOIN materia m ON m.usuario_id = r.usuario_id AND m.id = r.materia_id
            WHERE r.usuario_id = ? AND m.periodo_id = ? AND r.status = 'em_andamento' AND r.data_entrega IS NOT NULL AND r.data_entrega <= ? ORDER BY r.data_entrega`,
          [userId, period.id, addDays(date, PENDING_DAYS)],
        );
        for (const r of reports) {
          pending.push({
            type: 'report_delivery',
            title: r.titulo,
            subject: r.subject,
            due_date: r.data_entrega,
            days_left: daysBetween(date, r.data_entrega as string),
            reference: { type: 'report', id: r.id },
          });
        }
        const entryBase = `FROM registro g JOIN relatorio r ON r.usuario_id = g.usuario_id AND r.id = g.relatorio_id JOIN materia m ON m.usuario_id = r.usuario_id AND m.id = r.materia_id
           WHERE g.usuario_id = ? AND m.periodo_id = ? AND r.status = 'em_andamento'`;
        const [drafts] = await pool.query<RowDataPacket[]>(
          `SELECT g.id, g.data_hora, r.titulo, m.nome AS subject ${entryBase} AND g.status = 'rascunho' ORDER BY g.data_hora DESC`,
          [userId, period.id],
        );
        for (const g of drafts)
          pending.push({
            type: 'draft_entry',
            title: g.titulo,
            subject: g.subject,
            recorded_at: isoDate(g.data_hora as string),
            reference: { type: 'entry', id: g.id },
          });
        const [noPhotos] = await pool.query<RowDataPacket[]>(
          `SELECT g.id, g.data_hora, r.titulo, m.nome AS subject ${entryBase} AND g.status = 'concluido' AND g.data_hora >= ?
              AND NOT EXISTS (SELECT 1 FROM foto f WHERE f.usuario_id = g.usuario_id AND f.registro_id = g.id) ORDER BY g.data_hora DESC`,
          [userId, period.id, zonedToUtc(addDays(date, -NO_PHOTO_DAYS), '00:00', tz)],
        );
        for (const g of noPhotos)
          pending.push({
            type: 'entry_without_photos',
            title: g.titulo,
            subject: g.subject,
            recorded_at: isoDate(g.data_hora as string),
            reference: { type: 'entry', id: g.id },
          });
        const [exams] = await pool.query<RowDataPacket[]>(
          `SELECT e.id, e.titulo, e.data, e.tipo, m.nome AS subject FROM evento e LEFT JOIN materia m ON m.usuario_id = e.usuario_id AND m.id = e.materia_id
            WHERE e.usuario_id = ? AND e.tipo IN ('prova', 'trabalho') AND e.concluido = 0 AND e.encerrado_com_periodo = 0 AND e.data >= ? AND e.data <= ? ORDER BY e.data`,
          [userId, date, addDays(date, PENDING_DAYS)],
        );
        for (const e of exams) {
          pending.push({
            type: 'study_for_exam',
            title: e.titulo,
            subject: e.subject ?? null,
            event_type: eventType.toApi(e.tipo as string),
            due_date: e.data,
            days_left: daysBetween(date, e.data as string),
            reference: { type: 'event', id: e.id },
          });
        }
      }

      // ---- upcoming: field classes, exams, deliveries, activities, in the next 14 days (5 at most) ----
      const upcoming: { date: string; item: Record<string, unknown> }[] = [];
      if (period) {
        const [events] = await pool.query<RowDataPacket[]>(
          `SELECT e.id, e.tipo, e.titulo, e.data, m.nome AS subject FROM evento e LEFT JOIN materia m ON m.usuario_id = e.usuario_id AND m.id = e.materia_id
            WHERE e.usuario_id = ? AND e.concluido = 0 AND e.encerrado_com_periodo = 0 AND e.data >= ? AND e.data <= ?
              AND (e.materia_id IS NULL OR m.periodo_id = ?) ORDER BY e.data, e.criado_em`,
          [userId, date, addDays(date, UPCOMING_DAYS), period.id],
        );
        for (const e of events) {
          upcoming.push({
            date: e.data as string,
            item: {
              kind: 'event',
              id: e.id,
              type: eventType.toApi(e.tipo as string),
              title: e.titulo,
              subject: e.subject ?? null,
              date: e.data,
              days_left: daysBetween(date, e.data as string),
            },
          });
        }
        for (let i = 0; i <= UPCOMING_DAYS; i++) {
          const day = addDays(date, i);
          for (const s of onDay(day).filter(fieldClass)) {
            // what was left open in the visits of the report in progress of this subject
            const [todos] = await pool.query<RowDataPacket[]>(
              `SELECT p.texto FROM registro_pendencia p JOIN registro g ON g.usuario_id = p.usuario_id AND g.id = p.registro_id JOIN relatorio r ON r.usuario_id = g.usuario_id AND r.id = g.relatorio_id
                WHERE p.usuario_id = ? AND r.materia_id = ? AND r.status = 'em_andamento' AND p.feito = 0 ORDER BY g.data_hora, p.ordem`,
              [userId, s.id],
            );
            upcoming.push({
              date: day,
              item: {
                kind: 'field_class',
                subject: brief(s),
                date: day,
                days_left: i,
                forecast: i <= 1 ? forecastOf(day) : null,
                last_visit_todos: { count: todos.length, texts: todos.slice(0, 5).map((t) => t.texto as string) },
              },
            });
          }
        }
      }
      upcoming.sort((a, b) => a.date.localeCompare(b.date));

      // ---- recent activity: entries, notes and reports created or changed ----
      const [recent] = await pool.query<RowDataPacket[]>(
        `(SELECT 'entry' AS kind, g.id, r.titulo AS title, m.nome AS subject, g.status AS status, g.criado_em, g.atualizado_em
            FROM registro g JOIN relatorio r ON r.usuario_id = g.usuario_id AND r.id = g.relatorio_id JOIN materia m ON m.usuario_id = r.usuario_id AND m.id = r.materia_id WHERE g.usuario_id = ?
            ORDER BY g.atualizado_em DESC LIMIT ${RECENT_MAX})
         UNION ALL
         (SELECT 'note', a.id, a.titulo, m.nome, NULL, a.criado_em, a.atualizado_em FROM anotacao a LEFT JOIN materia m ON m.usuario_id = a.usuario_id AND m.id = a.materia_id
            WHERE a.usuario_id = ? ORDER BY a.atualizado_em DESC LIMIT ${RECENT_MAX})
         UNION ALL
         (SELECT 'report', r.id, r.titulo, m.nome, r.status, r.criado_em, r.atualizado_em FROM relatorio r JOIN materia m ON m.usuario_id = r.usuario_id AND m.id = r.materia_id
            WHERE r.usuario_id = ? ORDER BY r.atualizado_em DESC LIMIT ${RECENT_MAX})
         ORDER BY atualizado_em DESC LIMIT ${RECENT_MAX}`,
        [userId, userId, userId],
      );

      const news = newsBlock?.value?.[0] ?? null;
      const quotes = quotesBlock?.value ?? null;
      const dollar = dollarBlock?.value ?? null;

      return {
        date,
        active_period: period ? { id: period.id as string, name: period.nome as string } : null,
        subject_today: subjectToday,
        subjects_today: todays.map(brief),
        tomorrow: tomorrowBlock,
        pending,
        upcoming_events: upcoming.slice(0, UPCOMING_MAX).map((u) => u.item),
        recent_activity: recent.map((r) => ({
          kind: r.kind as string,
          action: (r.atualizado_em as string) === (r.criado_em as string) ? 'created' : 'updated',
          title: r.title as string,
          subject: (r.subject as string | null) ?? null,
          status: r.status
            ? r.status === 'rascunho'
              ? 'draft'
              : r.status === 'concluido'
                ? 'completed'
                : r.status === 'finalizado'
                  ? 'finished'
                  : 'in_progress'
            : null,
          at: isoDate(r.atualizado_em as string),
          reference: { type: r.kind === 'entry' ? 'entry' : r.kind === 'note' ? 'note' : 'report', id: r.id as string },
        })),
        market: market
          ? {
              soy: quotes?.soy ? { price: quotes.soy.price, change_pct: quotes.soy.change_pct } : null,
              corn: quotes?.corn ? { price: quotes.corn.price, change_pct: quotes.corn.change_pct } : null,
              dollar: dollar ? { value: dollar.value, change_pct: dollar.change_pct } : null,
              weather: weather ? { temperature_c: weather.temperature_c, description: weather.description } : null,
              stale: [quotesBlock, dollarBlock, weatherBlock, newsBlock].some((b) => b?.stale),
            }
          : null,
        news_of_the_day: news ? { id: news.id, title: news.title, published_at: news.published_at } : null,
        unread_notifications: await countUnread(pool, userId),
      };
    });
  };
