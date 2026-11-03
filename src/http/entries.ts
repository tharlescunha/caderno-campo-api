import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { fetchEntries, findEntry, serializeTodo } from '../entries/entries.js';
import {
  activity,
  cropCondition,
  entryStatus,
  inTransaction,
  irrigation,
  pageOf,
  pageQuery,
  pestLevel,
  uuid,
  weatherOrigin,
} from '../lib/common.js';
import { setTags, tagNames } from '../lib/tags.js';
import { AUDIOS_OF_ENTRY, audioFiles } from '../audios/audios.js';
import { PHOTOS_OF_ENTRY, photoFiles } from '../photos/photos.js';
import { assertReportOpen, findReport } from '../reports/reports.js';
import { ApiError, validate } from './errors.js';
import { indexEntry, removeFromIndex } from '../search/index.js';
import { requireAuth } from './require-auth.js';

const dateTime = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

const weather = z.object({
  origin: z.literal('manual'),
  description: z.string().trim().max(80).nullable().optional(),
  temperature_c: z.number().min(-60).max(70).nullable().optional(),
  feels_like_c: z.number().min(-60).max(70).nullable().optional(),
  humidity_pct: z.number().int().min(0).max(100).nullable().optional(),
  wind_kmh: z.number().min(0).max(999).nullable().optional(),
  rain_1h_mm: z.number().min(0).max(999).nullable().optional(),
  measured_at: dateTime.optional(),
});

const application = z.object({
  product: z.string().trim().max(160).nullable().optional(),
  dose: z.string().trim().max(80).nullable().optional(),
  target: z.string().trim().max(120).nullable().optional(),
});

const pest = z.object({
  found: z.boolean(),
  name: z.string().trim().min(1).max(120).nullable().optional(),
  level: z.enum(pestLevel.apiValues).nullable().optional(),
});

// A text, or { id, text } when the phone already created the item offline (the id is kept)
const nextVisitItem = z.union([
  z.string().trim().min(1).max(200),
  z.object({ id: uuid.optional(), text: z.string().trim().min(1).max(200) }),
]);
const nextVisit = z.array(nextVisitItem).max(10);

// Fields that can be set on create and changed on update. The weather and the coordinates are fixed at creation.
const common = {
  recorded_at: dateTime,
  status: z.enum(entryStatus.apiValues),
  activities: z.array(z.enum(activity.apiValues)).max(8),
  application: application.nullable(),
  irrigation: z.enum(irrigation.apiValues).nullable(),
  measurements: z.object({
    plant_height_cm: z.number().min(0).max(9999).nullable().optional(),
    measured_area_m2: z.number().min(0).max(99999999).nullable().optional(),
  }),
  crop_condition: z.enum(cropCondition.apiValues).nullable(),
  stage: z.string().trim().max(80).nullable(),
  pest,
  notes: z.string().max(50000).nullable(),
  next_visit: nextVisit,
  todos_done: z.array(uuid).max(50),
  tags: tagNames,
};

export const createBody = z.object({
  id: uuid.optional(),
  recorded_at: common.recorded_at.optional(),
  status: common.status.optional(),
  activities: common.activities.optional(),
  application: common.application.optional(),
  irrigation: common.irrigation.optional(),
  measurements: common.measurements.optional(),
  crop_condition: common.crop_condition.optional(),
  stage: common.stage.optional(),
  pest: common.pest.optional(),
  notes: common.notes.optional(),
  next_visit: common.next_visit.optional(),
  todos_done: common.todos_done.optional(),
  tags: common.tags.optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  weather: weather.optional(),
});

export const patchBody = z.object(common).partial().strict();

export const todoPatch = z
  .object({
    done: z.boolean(),
    text: z.string().trim().min(1).max(200),
  })
  .partial()
  .strict();

function fieldError(field: string, message: string): ApiError {
  return new ApiError(422, 'validation', 'Some fields are invalid.', [{ field, message }]);
}

/** Business rules shared by create and update (docs/api.md, section 7). */
function checkRules(
  activities: string[],
  applicationData: unknown,
  pestData: { found: boolean; name?: string | null | undefined } | undefined,
): void {
  if (applicationData && !activities.includes('application')) {
    throw fieldError('application', 'Application data needs the "application" activity.');
  }
  if (pestData?.found && !pestData.name) throw fieldError('pest.name', 'Name the pest.');
}

export const entryRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const { pool, media, market } = ctx;
    app.addHook('preHandler', requireAuth(ctx));

    /** Open to-do items of the report's entries other than `entryId`: the only ones that can be marked done now. */
    async function markTodosDone(tx: PoolConnection, userId: string, reportId: string, entryId: string, ids: string[]) {
      if (!ids.length) return;
      const [rows] = await tx.query<RowDataPacket[]>(
        `SELECT p.id FROM registro_pendencia p JOIN registro g ON g.usuario_id = p.usuario_id AND g.id = p.registro_id
          WHERE p.usuario_id = ? AND g.relatorio_id = ? AND p.registro_id <> ? AND p.feito = 0 AND p.id IN (?)`,
        [userId, reportId, entryId, ids],
      );
      if (rows.length !== new Set(ids).size)
        throw fieldError('todos_done', 'Some items are not open items of earlier visits of this report.');
      await tx.query(
        'UPDATE registro_pendencia SET feito = 1, feito_no_registro_id = ?, feito_em = NOW(3) WHERE usuario_id = ? AND id IN (?)',
        [entryId, userId, ids],
      );
    }

    async function insertTodos(tx: PoolConnection, userId: string, entryId: string, items: z.infer<typeof nextVisit>) {
      for (const [index, item] of items.entries()) {
        const text = typeof item === 'string' ? item : item.text;
        const itemId = typeof item === 'string' ? undefined : item.id;
        await tx.query('INSERT INTO registro_pendencia (id, usuario_id, registro_id, texto, ordem) VALUES (?, ?, ?, ?, ?)', [
          itemId ?? randomUUID(),
          userId,
          entryId,
          text,
          index,
        ]);
      }
    }

    app.get<{ Params: { id: string } }>('/reports/:id/entries', async (req) => {
      const reportId = validate(uuid, req.params.id);
      const { page, limit } = validate(pageQuery, req.query);
      await findReport(pool, req.userId, reportId);
      const [count] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM registro WHERE usuario_id = ? AND relatorio_id = ?', [
        req.userId,
        reportId,
      ]);
      const items = await fetchEntries(pool, req.userId, 'g.relatorio_id = ?', [reportId], { limit, offset: (page - 1) * limit });
      return pageOf(items, page, limit, Number(count[0]?.n ?? 0));
    });

    // Pending items of all visits of the report, oldest first: feeds the "From the last visit" card.
    app.get<{ Params: { id: string } }>('/reports/:id/todos', async (req) => {
      const reportId = validate(uuid, req.params.id);
      await findReport(pool, req.userId, reportId);
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT p.* FROM registro_pendencia p JOIN registro g ON g.usuario_id = p.usuario_id AND g.id = p.registro_id
          WHERE p.usuario_id = ? AND g.relatorio_id = ? AND p.feito = 0 ORDER BY g.data_hora, p.ordem`,
        [req.userId, reportId],
      );
      return { items: rows.map(serializeTodo) };
    });

    app.post<{ Params: { id: string } }>('/reports/:id/entries', async (req, reply) => {
      const reportId = validate(uuid, req.params.id);
      const b = validate(createBody, req.body);
      const report = await findReport(pool, req.userId, reportId);
      assertReportOpen(report);
      checkRules(b.activities ?? [], b.application, b.pest);
      const id = b.id ?? randomUUID();

      // Weather is frozen now and never recalculated (docs/api.md, section 1).
      // Typed by hand: as typed. With coordinates: ask the provider for the place of the visit; if it does not
      // answer in time the entry is `pending` and the scheduler fills it in later.
      if ((b.latitude === undefined) !== (b.longitude === undefined))
        throw fieldError('longitude', 'Send latitude and longitude together.');
      const hasCoordinates = b.latitude !== undefined && b.longitude !== undefined;
      const live = !b.weather && hasCoordinates && market ? await market.currentWeather(b.latitude!, b.longitude!) : null;
      const w =
        b.weather ??
        (live
          ? {
              origin: 'gps' as const,
              description: live.description,
              temperature_c: live.temperature_c,
              feels_like_c: live.feels_like_c,
              humidity_pct: live.humidity_pct,
              wind_kmh: live.wind_kmh,
              rain_1h_mm: live.rain_1h_mm,
              measured_at: new Date(live.observed_at),
            }
          : undefined);
      const origin = w ? w.origin : hasCoordinates ? 'pending' : null;

      await inTransaction(pool, async (tx) => {
        await tx.query(
          `INSERT INTO registro (id, usuario_id, relatorio_id, data_hora, status, atividades, aplicacao_produto, aplicacao_dose, aplicacao_alvo,
              irrigacao, altura_plantas_cm, area_medida_m2, cultura_estado, estagio, houve_praga, praga_nome, praga_nivel, observacoes,
              latitude, longitude, clima_origem, clima_descricao, clima_temperatura_c, clima_sensacao_c, clima_umidade_pct,
              clima_vento_kmh, clima_chuva_1h_mm, clima_medido_em)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            req.userId,
            reportId,
            b.recorded_at ?? new Date(),
            entryStatus.toDb(b.status ?? 'draft'),
            JSON.stringify((b.activities ?? []).map((a) => activity.toDb(a))),
            b.application?.product ?? null,
            b.application?.dose ?? null,
            b.application?.target ?? null,
            b.irrigation ? irrigation.toDb(b.irrigation) : null,
            b.measurements?.plant_height_cm ?? null,
            b.measurements?.measured_area_m2 ?? null,
            b.crop_condition ? cropCondition.toDb(b.crop_condition) : null,
            b.stage ?? null,
            b.pest?.found ? 1 : 0,
            b.pest?.found ? b.pest.name : null,
            b.pest?.found && b.pest.level ? pestLevel.toDb(b.pest.level) : null,
            b.notes ?? null,
            b.latitude ?? null,
            b.longitude ?? null,
            origin ? weatherOrigin.toDb(origin as never) : null,
            w?.description ?? null,
            w?.temperature_c ?? null,
            w?.feels_like_c ?? null,
            w?.humidity_pct ?? null,
            w?.wind_kmh ?? null,
            w?.rain_1h_mm ?? null,
            w ? (w.measured_at ?? new Date()) : null,
          ],
        );
        await insertTodos(tx, req.userId, id, b.next_visit ?? []);
        await markTodosDone(tx, req.userId, reportId, id, b.todos_done ?? []);
        if (b.tags) await setTags(tx, req.userId, { table: 'registro_tag', owner: 'registro_id' }, id, b.tags, false); // new item: no version bump
        await indexEntry(tx, req.userId, id);
      });
      return reply.status(201).send(await findEntry(pool, req.userId, id));
    });

    app.get<{ Params: { id: string } }>('/entries/:id', async (req) => findEntry(pool, req.userId, validate(uuid, req.params.id)));

    app.patch<{ Params: { id: string } }>('/entries/:id', async (req) => {
      const id = validate(uuid, req.params.id);
      const b = validate(patchBody, req.body);
      const current = await findEntry(pool, req.userId, id);
      assertReportOpen(await findReport(pool, req.userId, current.report_id));

      const activities = b.activities ?? current.activities;
      // without the "application" activity the stored application data is dropped, not an error
      const application_ = b.application !== undefined ? b.application : activities.includes('application') ? current.application : null;
      const pest_ = b.pest ?? { found: current.pest.found, name: current.pest.name };
      checkRules(activities, application_, pest_);

      await inTransaction(pool, async (tx) => {
        const sets: string[] = [];
        const values: unknown[] = [];
        const set = (column: string, value: unknown) => {
          sets.push(`${column} = ?`);
          values.push(value);
        };
        if (b.recorded_at !== undefined) set('data_hora', b.recorded_at);
        if (b.status !== undefined) set('status', entryStatus.toDb(b.status));
        if (b.activities !== undefined) set('atividades', JSON.stringify(b.activities.map((a) => activity.toDb(a))));
        if (b.application !== undefined || b.activities !== undefined) {
          const a = application_ && activities.includes('application') ? application_ : null;
          set('aplicacao_produto', a?.product ?? null);
          set('aplicacao_dose', a?.dose ?? null);
          set('aplicacao_alvo', a?.target ?? null);
        }
        if (b.irrigation !== undefined) set('irrigacao', b.irrigation ? irrigation.toDb(b.irrigation) : null);
        if (b.measurements !== undefined) {
          set('altura_plantas_cm', b.measurements.plant_height_cm ?? null);
          set('area_medida_m2', b.measurements.measured_area_m2 ?? null);
        }
        if (b.crop_condition !== undefined) set('cultura_estado', b.crop_condition ? cropCondition.toDb(b.crop_condition) : null);
        if (b.stage !== undefined) set('estagio', b.stage);
        if (b.pest !== undefined) {
          set('houve_praga', b.pest.found ? 1 : 0);
          set('praga_nome', b.pest.found ? b.pest.name : null);
          set('praga_nivel', b.pest.found && b.pest.level ? pestLevel.toDb(b.pest.level) : null);
        }
        if (b.notes !== undefined) set('observacoes', b.notes);
        if (sets.length)
          await tx.query(`UPDATE registro SET ${sets.join(', ')} WHERE usuario_id = ? AND id = ?`, [...values, req.userId, id]);

        if (b.next_visit !== undefined) {
          // replaces the items this entry left that are still open; done ones stay as history
          await tx.query('DELETE FROM registro_pendencia WHERE usuario_id = ? AND registro_id = ? AND feito = 0', [req.userId, id]);
          await insertTodos(tx, req.userId, id, b.next_visit);
        }
        if (b.todos_done !== undefined) await markTodosDone(tx, req.userId, current.report_id, id, b.todos_done);
        if (b.tags !== undefined) await setTags(tx, req.userId, { table: 'registro_tag', owner: 'registro_id' }, id, b.tags);
        await indexEntry(tx, req.userId, id);
      });
      return findEntry(pool, req.userId, id);
    });

    app.delete<{ Params: { id: string } }>('/entries/:id', async (req, reply) => {
      const id = validate(uuid, req.params.id);
      const current = await findEntry(pool, req.userId, id);
      assertReportOpen(await findReport(pool, req.userId, current.report_id));
      const files = [
        ...(await photoFiles(pool, req.userId, PHOTOS_OF_ENTRY, [id])),
        ...(await audioFiles(pool, req.userId, AUDIOS_OF_ENTRY, [id])),
      ];
      await inTransaction(pool, async (tx) => {
        // no foreign key points here from `feito_no_registro_id`, so reopen the items this entry had closed
        await tx.query(
          'UPDATE registro_pendencia SET feito = 0, feito_no_registro_id = NULL, feito_em = NULL WHERE usuario_id = ? AND feito_no_registro_id = ?',
          [req.userId, id],
        );
        await tx.query('DELETE FROM registro WHERE usuario_id = ? AND id = ?', [req.userId, id]);
        await removeFromIndex(tx, 'registro', [id]);
      });
      await media.remove(files);
      return reply.status(204).send();
    });

    async function ownTodo(userId: string, id: string) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT p.*, g.relatorio_id FROM registro_pendencia p JOIN registro g ON g.usuario_id = p.usuario_id AND g.id = p.registro_id
          WHERE p.usuario_id = ? AND p.id = ?`,
        [userId, id],
      );
      if (!rows[0]) throw new ApiError(404, 'not_found', 'Item not found.');
      assertReportOpen(await findReport(pool, userId, rows[0].relatorio_id as string));
      return rows[0];
    }

    app.get<{ Params: { id: string } }>('/todos/:id', async (req) => {
      const id = validate(uuid, req.params.id);
      const [rows] = await pool.query<RowDataPacket[]>('SELECT * FROM registro_pendencia WHERE usuario_id = ? AND id = ?', [
        req.userId,
        id,
      ]);
      if (!rows[0]) throw new ApiError(404, 'not_found', 'Item not found.');
      return serializeTodo(rows[0]);
    });

    app.patch<{ Params: { id: string } }>('/todos/:id', async (req) => {
      const id = validate(uuid, req.params.id);
      const b = validate(todoPatch, req.body);
      await ownTodo(req.userId, id);
      const sets: string[] = [];
      const values: unknown[] = [];
      if (b.text !== undefined) {
        sets.push('texto = ?');
        values.push(b.text);
      }
      if (b.done !== undefined) {
        sets.push(b.done ? 'feito = 1, feito_em = NOW(3)' : 'feito = 0, feito_em = NULL, feito_no_registro_id = NULL');
      }
      if (sets.length)
        await pool.query(`UPDATE registro_pendencia SET ${sets.join(', ')} WHERE usuario_id = ? AND id = ?`, [...values, req.userId, id]);
      const [rows] = await pool.query<RowDataPacket[]>('SELECT * FROM registro_pendencia WHERE usuario_id = ? AND id = ?', [
        req.userId,
        id,
      ]);
      await indexEntry(pool, req.userId, rows[0]!.registro_id as string);
      return serializeTodo(rows[0]!);
    });

    app.delete<{ Params: { id: string } }>('/todos/:id', async (req, reply) => {
      const id = validate(uuid, req.params.id);
      const todo = await ownTodo(req.userId, id);
      await pool.query('DELETE FROM registro_pendencia WHERE usuario_id = ? AND id = ?', [req.userId, id]);
      await indexEntry(pool, req.userId, todo.registro_id as string);
      return reply.status(204).send();
    });
  };
