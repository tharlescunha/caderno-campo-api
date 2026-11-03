import type { RowDataPacket } from 'mysql2/promise';
import { ApiError } from '../http/errors.js';
import { activity, cropCondition, entryStatus, irrigation, pestLevel, weatherOrigin, type Db } from '../lib/common.js';
import { loadTags } from '../lib/tags.js';
import { fetchHistory } from '../sync/history.js';
import { fetchAudios, type AudioItem } from '../audios/audios.js';
import { fetchPhotos, type PhotoItem } from '../photos/photos.js';
import { isoDate } from '../users/user.js';

export const ENTRY_COLUMNS = `g.id, g.relatorio_id, g.data_hora, g.status, g.atividades, g.aplicacao_produto, g.aplicacao_dose, g.aplicacao_alvo,
  g.irrigacao, g.altura_plantas_cm, g.area_medida_m2, g.cultura_estado, g.estagio, g.houve_praga, g.praga_nome, g.praga_nivel, g.observacoes,
  g.latitude, g.longitude, g.clima_origem, g.clima_descricao, g.clima_temperatura_c, g.clima_sensacao_c, g.clima_umidade_pct,
  g.clima_vento_kmh, g.clima_chuva_1h_mm, g.clima_medido_em, g.criado_em, g.atualizado_em, g.versao`;

const num = (v: unknown) => (v == null ? null : Number(v));

export async function fetchEntries(db: Db, userId: string, where: string, params: unknown[], paging?: { limit: number; offset: number }) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${ENTRY_COLUMNS} FROM registro g WHERE g.usuario_id = ? AND ${where} ORDER BY g.data_hora DESC, g.criado_em DESC${paging ? ' LIMIT ? OFFSET ?' : ''}`,
    [userId, ...params, ...(paging ? [paging.limit, paging.offset] : [])],
  );
  const ids = rows.map((r) => r.id as string);
  const tags = await loadTags(db, userId, { table: 'registro_tag', owner: 'registro_id' }, ids);
  const history = await fetchHistory(db, userId, 'entry', ids);
  const photos = new Map<string, PhotoItem[]>();
  if (ids.length) {
    for (const photo of await fetchPhotos(db, userId, 'registro_id IN (?)', [ids])) {
      photos.set(photo.entry_id!, [...(photos.get(photo.entry_id!) ?? []), photo]);
    }
  }
  const audios = new Map<string, AudioItem[]>();
  if (ids.length) {
    for (const audio of await fetchAudios(db, userId, 'registro_id IN (?)', [ids])) {
      audios.set(audio.entry_id!, [...(audios.get(audio.entry_id!) ?? []), audio]);
    }
  }
  const todos = new Map<string, ReturnType<typeof serializeTodo>[]>();
  if (ids.length) {
    const [todoRows] = await db.query<RowDataPacket[]>(
      'SELECT * FROM registro_pendencia WHERE usuario_id = ? AND registro_id IN (?) ORDER BY ordem',
      [userId, ids],
    );
    for (const t of todoRows) todos.set(t.registro_id as string, [...(todos.get(t.registro_id as string) ?? []), serializeTodo(t)]);
  }
  return rows.map((r) => ({
    id: r.id as string,
    report_id: r.relatorio_id as string,
    recorded_at: isoDate(r.data_hora as string),
    status: entryStatus.toApi(r.status as string),
    activities: (typeof r.atividades === 'string' ? JSON.parse(r.atividades) : r.atividades).map((a: string) =>
      activity.toApi(a),
    ) as string[],
    application:
      r.aplicacao_produto || r.aplicacao_dose || r.aplicacao_alvo
        ? {
            product: (r.aplicacao_produto as string | null) ?? null,
            dose: (r.aplicacao_dose as string | null) ?? null,
            target: (r.aplicacao_alvo as string | null) ?? null,
          }
        : null,
    irrigation: r.irrigacao ? irrigation.toApi(r.irrigacao as string) : null,
    measurements: { plant_height_cm: num(r.altura_plantas_cm), measured_area_m2: num(r.area_medida_m2) },
    crop_condition: r.cultura_estado ? cropCondition.toApi(r.cultura_estado as string) : null,
    stage: (r.estagio as string | null) ?? null,
    pest: {
      found: r.houve_praga === 1,
      name: (r.praga_nome as string | null) ?? null,
      level: r.praga_nivel ? pestLevel.toApi(r.praga_nivel as string) : null,
    },
    notes: (r.observacoes as string | null) ?? null,
    latitude: num(r.latitude),
    longitude: num(r.longitude),
    weather_origin: r.clima_origem ? weatherOrigin.toApi(r.clima_origem as string) : null,
    weather:
      r.clima_temperatura_c == null && !r.clima_descricao
        ? null
        : {
            description: (r.clima_descricao as string | null) ?? null,
            temperature_c: num(r.clima_temperatura_c),
            feels_like_c: num(r.clima_sensacao_c),
            humidity_pct: num(r.clima_umidade_pct),
            wind_kmh: num(r.clima_vento_kmh),
            rain_1h_mm: num(r.clima_chuva_1h_mm),
            measured_at: isoDate(r.clima_medido_em as string | null),
          },
    text_history: history.get(r.id as string) ?? [],
    photos: photos.get(r.id as string) ?? [],
    audios: audios.get(r.id as string) ?? [],
    todos: todos.get(r.id as string) ?? [],
    tags: tags.get(r.id as string) ?? [],
    created_at: isoDate(r.criado_em as string),
    updated_at: isoDate(r.atualizado_em as string),
    version: r.versao as number,
  }));
}

export type EntryItem = Awaited<ReturnType<typeof fetchEntries>>[number];

export function serializeTodo(t: RowDataPacket) {
  return {
    id: t.id as string,
    entry_id: t.registro_id as string,
    text: t.texto as string,
    order: t.ordem as number,
    done: t.feito === 1,
    done_in_entry_id: (t.feito_no_registro_id as string | null) ?? null,
    done_at: isoDate(t.feito_em as string | null),
    version: t.versao as number,
  };
}

export async function findEntry(db: Db, userId: string, id: string): Promise<EntryItem> {
  const [item] = await fetchEntries(db, userId, 'g.id = ?', [id]);
  if (!item) throw new ApiError(404, 'not_found', 'Entry not found.');
  return item;
}
