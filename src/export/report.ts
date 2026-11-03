import type { RowDataPacket } from 'mysql2/promise';
import { zipSync } from 'fflate';
import { ApiError } from '../http/errors.js';
import type { Db } from '../lib/common.js';
import type { MediaStorage } from '../media/storage.js';

/** Byte order mark: makes Excel read the CSV as UTF-8. */
const BOM = String.fromCharCode(0xfeff);

export const INCLUDE_KEYS = ['dates', 'weather', 'activities', 'notes', 'measurements', 'pest_irrigation', 'place', 'photos'] as const;
export type IncludeKey = (typeof INCLUDE_KEYS)[number];
/** Everything but the place (coordinates) unless asked for. */
export const DEFAULT_INCLUDE: IncludeKey[] = INCLUDE_KEYS.filter((k) => k !== 'place');

// This is a document for the user to paste into the college template: texts are in Portuguese.
const ACTIVITY: Record<string, string> = {
  adubacao: 'adubação',
  limpeza: 'limpeza',
  vistoria: 'vistoria',
  aplicacao: 'aplicação',
  irrigacao: 'irrigação',
  plantio: 'plantio',
  colheita: 'colheita',
  outro: 'outro',
};
const IRRIGATION: Record<string, string> = {
  funcionando: 'funcionando',
  com_falha: 'com falha',
  sem_irrigacao: 'sem irrigação',
  a_instalar: 'a instalar',
};
const CONDITION: Record<string, string> = { otima: 'ótima', boa: 'boa', regular: 'regular', ruim: 'ruim' };
const LEVEL: Record<string, string> = { baixo: 'baixo', medio: 'médio', alto: 'alto' };
const AREA_NUMBER = (n: unknown) => String(Number(n)).replace('.', ',');

interface Photo {
  arquivo: string | null;
  tipo_mime: string;
}

interface ExportEntry {
  row: RowDataPacket;
  number: number;
  photos: Photo[];
  audios: { arquivo: string | null; tipo_mime: string; text: string | null }[];
  todos: string[];
  when: { date: string; time: string; stamp: string }; // dd/mm/yyyy, HH:MM, yyyy-mm-dd_hhmm (user's time)
}

export interface ReportExport {
  title: string;
  slug: string;
  header: string[];
  entries: ExportEntry[];
}

function localParts(value: string, timezone: string) {
  const d = new Date(`${value.replace(' ', 'T')}Z`);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  return {
    date: `${p.day}/${p.month}/${p.year}`,
    time: `${p.hour}:${p.minute}`,
    stamp: `${p.year}-${p.month}-${p.day}_${p.hour}${p.minute}`,
  };
}

const slugOf = (title: string) =>
  title
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'relatorio';

/** Loads a report and all its entries (oldest first) with photos, audios and next-visit items. */
export async function loadReportExport(db: Db, userId: string, reportId: string, timezone: string): Promise<ReportExport> {
  const [reports] = await db.query<RowDataPacket[]>(
    `SELECT r.titulo, r.tipo, r.area_cultura, r.area_local, r.area_comprimento_m, r.area_largura_m, r.area_m2, r.observacoes, m.nome AS materia, p.nome AS professor
       FROM relatorio r JOIN materia m ON m.usuario_id = r.usuario_id AND m.id = r.materia_id
       LEFT JOIN professor p ON p.usuario_id = m.usuario_id AND p.id = m.professor_id WHERE r.usuario_id = ? AND r.id = ?`,
    [userId, reportId],
  );
  const r = reports[0];
  if (!r) throw new ApiError(404, 'not_found', 'Report not found.');

  const header = [`RELATÓRIO: ${r.titulo}`, `Matéria: ${r.materia}${r.professor ? ` · ${r.professor}` : ''}`];
  if (r.area_cultura || r.area_local || r.area_m2 != null) {
    const size =
      r.area_comprimento_m != null && r.area_largura_m != null
        ? `${AREA_NUMBER(r.area_comprimento_m)} × ${AREA_NUMBER(r.area_largura_m)} m (${AREA_NUMBER(r.area_m2)} m²)`
        : null;
    header.push(`Área: ${[r.area_cultura, r.area_local, size].filter(Boolean).join(' · ')}`);
  }
  if (r.observacoes) header.push(`Orientações: ${String(r.observacoes).replace(/\s+/g, ' ')}`);

  const [rows] = await db.query<RowDataPacket[]>(
    'SELECT * FROM registro WHERE usuario_id = ? AND relatorio_id = ? ORDER BY data_hora, criado_em',
    [userId, reportId],
  );
  const ids = rows.map((x) => x.id as string);
  const photoRows = ids.length
    ? (
        await db.query<RowDataPacket[]>(
          'SELECT registro_id, arquivo, tipo_mime FROM foto WHERE usuario_id = ? AND registro_id IN (?) ORDER BY tirada_em, criado_em, id',
          [userId, ids],
        )
      )[0]
    : [];
  const audioRows = ids.length
    ? (
        await db.query<RowDataPacket[]>(
          'SELECT registro_id, arquivo, tipo_mime, COALESCE(transcricao_editada, transcricao) AS texto FROM audio WHERE usuario_id = ? AND registro_id IN (?) ORDER BY gravado_em, id',
          [userId, ids],
        )
      )[0]
    : [];
  const todoRows = ids.length
    ? (
        await db.query<RowDataPacket[]>(
          'SELECT registro_id, texto FROM registro_pendencia WHERE usuario_id = ? AND registro_id IN (?) ORDER BY ordem',
          [userId, ids],
        )
      )[0]
    : [];

  const entries = rows.map((row, i): ExportEntry => {
    const id = row.id as string;
    return {
      row,
      number: i + 1,
      photos: photoRows
        .filter((x) => x.registro_id === id)
        .map((x) => ({ arquivo: x.arquivo as string | null, tipo_mime: x.tipo_mime as string })),
      audios: audioRows
        .filter((x) => x.registro_id === id)
        .map((x) => ({ arquivo: x.arquivo as string | null, tipo_mime: x.tipo_mime as string, text: (x.texto as string | null) ?? null })),
      todos: todoRows.filter((x) => x.registro_id === id).map((x) => x.texto as string),
      when: localParts(row.data_hora as string, timezone),
    };
  });
  return { title: r.titulo as string, slug: slugOf(r.titulo as string), header, entries };
}

const activitiesOf = (row: RowDataPacket): string[] =>
  ((typeof row.atividades === 'string' ? JSON.parse(row.atividades) : row.atividades) as string[]) ?? [];
const oneLine = (s: unknown) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/** Notes of an entry: what the user wrote, what was said in the audios, and the items left for the next visit. */
function noteLines(e: ExportEntry): string[] {
  const out: string[] = [];
  if (e.row.observacoes) out.push(`Observações: ${oneLine(e.row.observacoes)}`);
  for (const a of e.audios) if (a.text) out.push(`Áudio: ${oneLine(a.text)}`);
  if (e.todos.length) out.push(`Para a próxima visita: ${e.todos.join('; ')}`);
  return out;
}

function weatherLine(row: RowDataPacket): string | null {
  if (row.clima_temperatura_c == null && !row.clima_descricao) return null;
  const parts = [
    row.clima_temperatura_c != null ? `${AREA_NUMBER(row.clima_temperatura_c)}°` : null,
    row.clima_descricao ? String(row.clima_descricao) : null,
    row.clima_umidade_pct != null ? `umidade ${row.clima_umidade_pct}%` : null,
    row.clima_vento_kmh != null ? `vento ${AREA_NUMBER(row.clima_vento_kmh)} km/h` : null,
    row.clima_chuva_1h_mm != null ? `chuva ${AREA_NUMBER(row.clima_chuva_1h_mm)} mm` : null,
  ].filter(Boolean);
  return `Clima: ${parts.join(' · ')}`;
}

/** One block per entry, oldest first (docs/api.md, section 8). */
export function reportText(data: ReportExport, include: Set<IncludeKey>): string {
  const blocks = data.entries.map((e) => {
    const row = e.row;
    const lines: string[] = [];
    const stamp = include.has('dates') ? `${e.when.date} ${e.when.time}` : `Registro ${e.number}`;
    lines.push(`[${stamp}]${row.status === 'rascunho' ? ' (rascunho)' : ''}`);
    if (include.has('weather')) {
      const w = weatherLine(row);
      if (w) lines.push(w);
    }
    if (include.has('activities')) {
      const acts = activitiesOf(row);
      if (acts.length) lines.push(`Atividades: ${acts.map((a) => ACTIVITY[a] ?? a).join(', ')}`);
      if (row.aplicacao_produto || row.aplicacao_dose || row.aplicacao_alvo) {
        lines.push(
          `Aplicação: ${[row.aplicacao_produto, row.aplicacao_dose, row.aplicacao_alvo && `alvo: ${row.aplicacao_alvo}`].filter(Boolean).join(' · ')}`,
        );
      }
    }
    if (include.has('measurements')) {
      const parts = [
        row.altura_plantas_cm != null ? `altura das plantas ${AREA_NUMBER(row.altura_plantas_cm)} cm` : null,
        row.area_medida_m2 != null ? `área medida ${AREA_NUMBER(row.area_medida_m2)} m²` : null,
        row.cultura_estado ? `estado da cultura ${CONDITION[row.cultura_estado as string]}` : null,
        row.estagio ? `estágio ${row.estagio}` : null,
      ].filter(Boolean);
      if (parts.length) lines.push(`Medidas: ${parts.join(' · ')}`);
    }
    if (include.has('pest_irrigation')) {
      const parts = [
        row.irrigacao ? `irrigação ${IRRIGATION[row.irrigacao as string]}` : null,
        row.houve_praga === 1 ? `praga: ${row.praga_nome}${row.praga_nivel ? ` (nível ${LEVEL[row.praga_nivel as string]})` : ''}` : null,
      ].filter(Boolean);
      if (parts.length) lines.push(`Irrigação e pragas: ${parts.join(' · ')}`);
    }
    if (include.has('place') && row.latitude != null && row.longitude != null)
      lines.push(`Local: ${AREA_NUMBER(row.latitude)}, ${AREA_NUMBER(row.longitude)}`);
    if (include.has('notes')) lines.push(...noteLines(e));
    if (include.has('photos') && e.photos.length) lines.push(`Fotos: ${e.photos.length}`);
    return lines.join('\n');
  });
  return `${[...data.header, '', ...(blocks.length ? [blocks.join('\n\n')] : ['(sem registros ainda)'])].join('\n')}\n`;
}

const cell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const dec = (v: unknown) => (v == null ? '' : AREA_NUMBER(v));

/** `;` separator and BOM (opens in Excel), one row per entry, columns follow `include`. */
export function reportCsv(data: ReportExport, include: Set<IncludeKey>): string {
  const columns: [string, (e: ExportEntry) => unknown][] = [
    ['numero', (e) => e.number],
    ['situacao', (e) => (e.row.status === 'rascunho' ? 'rascunho' : 'concluido')],
  ];
  if (include.has('dates')) columns.push(['data', (e) => e.when.date], ['hora', (e) => e.when.time]);
  if (include.has('weather')) {
    columns.push(
      ['clima', (e) => e.row.clima_descricao],
      ['temperatura_c', (e) => dec(e.row.clima_temperatura_c)],
      ['umidade_pct', (e) => e.row.clima_umidade_pct],
      ['vento_kmh', (e) => dec(e.row.clima_vento_kmh)],
      ['chuva_mm', (e) => dec(e.row.clima_chuva_1h_mm)],
    );
  }
  if (include.has('activities')) {
    columns.push(
      [
        'atividades',
        (e) =>
          activitiesOf(e.row)
            .map((a) => ACTIVITY[a] ?? a)
            .join(', '),
      ],
      ['produto', (e) => e.row.aplicacao_produto],
      ['dose', (e) => e.row.aplicacao_dose],
      ['alvo', (e) => e.row.aplicacao_alvo],
    );
  }
  if (include.has('measurements')) {
    columns.push(
      ['altura_plantas_cm', (e) => dec(e.row.altura_plantas_cm)],
      ['area_medida_m2', (e) => dec(e.row.area_medida_m2)],
      ['estado_cultura', (e) => (e.row.cultura_estado ? CONDITION[e.row.cultura_estado as string] : '')],
      ['estagio', (e) => e.row.estagio],
    );
  }
  if (include.has('pest_irrigation')) {
    columns.push(
      ['irrigacao', (e) => (e.row.irrigacao ? IRRIGATION[e.row.irrigacao as string] : '')],
      ['praga', (e) => (e.row.houve_praga === 1 ? e.row.praga_nome : '')],
      ['nivel_praga', (e) => (e.row.houve_praga === 1 && e.row.praga_nivel ? LEVEL[e.row.praga_nivel as string] : '')],
    );
  }
  if (include.has('place')) columns.push(['latitude', (e) => dec(e.row.latitude)], ['longitude', (e) => dec(e.row.longitude)]);
  if (include.has('notes')) columns.push(['observacoes', (e) => noteLines(e).join(' | ')]);
  if (include.has('photos')) columns.push(['fotos', (e) => e.photos.length]);
  const lines = [columns.map(([name]) => name).join(';'), ...data.entries.map((e) => columns.map(([, fn]) => cell(fn(e))).join(';'))];
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

const EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
};

/** The text, the CSV, and the `fotos/` and `audios/` folders (names `AAAA-MM-DD_hhmm_n.ext`). */
export async function reportZip(data: ReportExport, include: Set<IncludeKey>, media: MediaStorage): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    [`relatorio-${data.slug}.txt`]: enc.encode(reportText(data, include)),
    [`relatorio-${data.slug}.csv`]: enc.encode(reportCsv(data, include)),
  };
  if (include.has('photos')) {
    for (const e of data.entries) {
      for (const [i, p] of e.photos.entries()) {
        if (p.arquivo)
          files[`fotos/${e.when.stamp}_${i + 1}.${EXTENSION[p.tipo_mime] ?? 'bin'}`] = [
            new Uint8Array(await media.read(p.arquivo)),
            { level: 0 },
          ];
      }
      for (const [i, a] of e.audios.entries()) {
        if (a.arquivo)
          files[`audios/${e.when.stamp}_${i + 1}.${EXTENSION[a.tipo_mime] ?? 'bin'}`] = [
            new Uint8Array(await media.read(a.arquivo)),
            { level: 0 },
          ];
      }
    }
  }
  return zipSync(files);
}
