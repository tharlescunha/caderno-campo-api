import type { RowDataPacket } from 'mysql2/promise';
import type { Db } from '../lib/common.js';
import { addDays, isoWeekday, localDate } from '../lib/time.js';
import { serializePeriod } from '../periods/periods.js';

/** Byte order mark: makes Excel read the CSV as UTF-8. */
const BOM = String.fromCharCode(0xfeff);

const LEVELS = ['low', 'medium', 'high'] as const;
const MAX_WEEKS = 60;

export interface PeriodSummary {
  period: { id: string; name: string; start_date: string; end_date: string | null; status: string };
  until: string;
  totals: { visits: number; reports: number; crops: number; photos: number; notes: number; subjects: number };
  crops: {
    report_id: string;
    crop: string;
    place: string | null;
    area_m2: number | null;
    visits: number;
    first_visit: string;
    last_visit: string;
  }[];
  pests: { name: string; times: number; max_level: string | null }[];
  products: { name: string; times: number }[];
  by_subject: { subject_id: string; name: string; reports: number; entries: number }[];
  weeks: { start: string; entries: number }[];
}

// Entries of the period: through report and subject. Only completed entries count (drafts are not visits yet).
const ENTRIES = `FROM registro g
  JOIN relatorio r ON r.usuario_id = g.usuario_id AND r.id = g.relatorio_id
  JOIN materia m ON m.usuario_id = r.usuario_id AND m.id = r.materia_id
  WHERE g.usuario_id = ? AND m.periodo_id = ? AND g.status = 'concluido'`;

/** The "Period summary" screen: read-only, everything calculated from the data (docs/banco-de-dados.md, section 6). */
export async function periodSummary(
  db: Db,
  userId: string,
  period: RowDataPacket,
  timezone: string,
  now = new Date(),
): Promise<PeriodSummary> {
  const p = [userId, period.id];
  const today = localDate(now, timezone);
  // an active period is partial (until today); a finished one goes until its end date
  const until = period.status === 'ativo' ? today : ((period.data_fim as string | null) ?? today);

  const [totals] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS visits, COUNT(DISTINCT r.id) AS reports, COUNT(DISTINCT r.area_cultura) AS crops ${ENTRIES}`,
    p,
  );
  const [photos] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM foto f JOIN registro g ON g.usuario_id = f.usuario_id AND g.id = f.registro_id
       JOIN relatorio r ON r.usuario_id = g.usuario_id AND r.id = g.relatorio_id JOIN materia m ON m.usuario_id = r.usuario_id AND m.id = r.materia_id
      WHERE f.usuario_id = ? AND m.periodo_id = ?`,
    p,
  );
  const [notes] = await db.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS n FROM anotacao a JOIN materia m ON m.usuario_id = a.usuario_id AND m.id = a.materia_id WHERE a.usuario_id = ? AND m.periodo_id = ?',
    p,
  );
  const [subjects] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM materia WHERE usuario_id = ? AND periodo_id = ?', p);

  const [cropRows] = await db.query<RowDataPacket[]>(
    `SELECT r.id, r.area_cultura, r.area_local, r.area_m2, COUNT(*) AS visits, MIN(g.data_hora) AS first_visit, MAX(g.data_hora) AS last_visit
       ${ENTRIES} AND r.area_cultura IS NOT NULL GROUP BY r.id, r.area_cultura, r.area_local, r.area_m2 ORDER BY first_visit`,
    p,
  );
  const [pestRows] = await db.query<RowDataPacket[]>(
    `SELECT MIN(g.praga_nome) AS name, COUNT(*) AS times, MAX(CASE g.praga_nivel WHEN 'baixo' THEN 1 WHEN 'medio' THEN 2 WHEN 'alto' THEN 3 ELSE 0 END) AS level
       ${ENTRIES} AND g.houve_praga = 1 GROUP BY g.praga_nome ORDER BY times DESC, name`,
    p,
  );
  const [productRows] = await db.query<RowDataPacket[]>(
    `SELECT MIN(g.aplicacao_produto) AS name, COUNT(*) AS times ${ENTRIES} AND g.aplicacao_produto IS NOT NULL GROUP BY g.aplicacao_produto ORDER BY times DESC, name`,
    p,
  );
  const [subjectRows] = await db.query<RowDataPacket[]>(
    `SELECT m.id, m.nome, COUNT(DISTINCT r.id) AS reports, COUNT(g.id) AS entries ${ENTRIES} GROUP BY m.id, m.nome ORDER BY m.nome`,
    p,
  );
  const [dates] = await db.query<RowDataPacket[]>(`SELECT g.data_hora ${ENTRIES} ORDER BY g.data_hora`, p);

  // weeks (Monday to Sunday, in the user's time) from the start of the period to `until`, empty ones included
  const perWeek = new Map<string, number>();
  for (const row of dates) {
    const day = localDate(new Date(`${(row.data_hora as string).replace(' ', 'T')}Z`), timezone);
    const monday = addDays(day, 1 - isoWeekday(day));
    perWeek.set(monday, (perWeek.get(monday) ?? 0) + 1);
  }
  const startDay = period.data_inicio as string;
  const weeks: PeriodSummary['weeks'] = [];
  for (let monday = addDays(startDay, 1 - isoWeekday(startDay)); monday <= until && weeks.length < MAX_WEEKS; monday = addDays(monday, 7)) {
    weeks.push({ start: monday, entries: perWeek.get(monday) ?? 0 });
  }

  const base = serializePeriod(period);
  const dayOf = (v: string) => localDate(new Date(`${v.replace(' ', 'T')}Z`), timezone);
  return {
    period: { id: base.id, name: base.name, start_date: base.start_date, end_date: base.end_date, status: base.status },
    until,
    totals: {
      visits: Number(totals[0]?.visits ?? 0),
      reports: Number(totals[0]?.reports ?? 0),
      crops: Number(totals[0]?.crops ?? 0),
      photos: Number(photos[0]?.n ?? 0),
      notes: Number(notes[0]?.n ?? 0),
      subjects: Number(subjects[0]?.n ?? 0),
    },
    crops: cropRows.map((r) => ({
      report_id: r.id as string,
      crop: r.area_cultura as string,
      place: (r.area_local as string | null) ?? null,
      area_m2: r.area_m2 == null ? null : Number(r.area_m2),
      visits: Number(r.visits),
      first_visit: dayOf(r.first_visit as string),
      last_visit: dayOf(r.last_visit as string),
    })),
    pests: pestRows.map((r) => ({
      name: r.name as string,
      times: Number(r.times),
      max_level: Number(r.level) > 0 ? LEVELS[Number(r.level) - 1]! : null,
    })),
    products: productRows.map((r) => ({ name: r.name as string, times: Number(r.times) })),
    by_subject: subjectRows.map((r) => ({
      subject_id: r.id as string,
      name: r.nome as string,
      reports: Number(r.reports),
      entries: Number(r.entries),
    })),
    weeks,
  };
}

const LEVEL_PT: Record<string, string> = { low: 'baixo', medium: 'médio', high: 'alto' };
const br = (iso: string) => iso.split('-').reverse().join('/');
const num = (n: number) => String(n).replace('.', ',');

/** Plain text of the summary, in Portuguese (it is a document for the user's portfolio). */
export function summaryText(s: PeriodSummary): string {
  const lines = [
    `RESUMO DO PERÍODO: ${s.period.name}`,
    `De ${br(s.period.start_date)} até ${br(s.until)}${s.period.status === 'active' ? ' (período em andamento)' : ''}`,
    '',
    `Visitas de campo: ${s.totals.visits} · Relatórios: ${s.totals.reports} · Culturas: ${s.totals.crops}`,
    `Fotos: ${s.totals.photos} · Anotações: ${s.totals.notes} · Matérias: ${s.totals.subjects}`,
  ];
  if (s.crops.length) {
    lines.push('', 'CULTURAS ACOMPANHADAS');
    for (const c of s.crops) {
      const area = c.area_m2 == null ? '' : ` · ${num(c.area_m2)} m²`;
      lines.push(
        `- ${c.crop}${c.place ? ` (${c.place})` : ''}${area}: ${c.visits} visita(s), de ${br(c.first_visit)} a ${br(c.last_visit)}`,
      );
    }
  }
  if (s.pests.length) {
    lines.push('', 'PRAGAS VISTAS');
    for (const p of s.pests) lines.push(`- ${p.name}: ${p.times} vez(es)${p.max_level ? `, nível máximo ${LEVEL_PT[p.max_level]}` : ''}`);
  }
  if (s.products.length) {
    lines.push('', 'PRODUTOS APLICADOS');
    for (const p of s.products) lines.push(`- ${p.name}: ${p.times} vez(es)`);
  }
  if (s.by_subject.length) {
    lines.push('', 'POR MATÉRIA');
    for (const m of s.by_subject) lines.push(`- ${m.name}: ${m.reports} relatório(s), ${m.entries} registro(s)`);
  }
  if (s.weeks.length) {
    lines.push('', 'REGISTROS POR SEMANA');
    for (const w of s.weeks) lines.push(`- Semana de ${br(w.start)}: ${w.entries}`);
  }
  return `${lines.join('\n')}\n`;
}

const cell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV (`;` separator, BOM for Excel): one row per item, `secao;nome;quantidade;detalhe`. */
export function summaryCsv(s: PeriodSummary): string {
  const rows: unknown[][] = [['secao', 'nome', 'quantidade', 'detalhe']];
  const add = (section: string, name: string, quantity: number, detail = '') => rows.push([section, name, quantity, detail]);
  for (const [name, value] of Object.entries(s.totals)) add('totais', name, value);
  for (const c of s.crops) add('culturas', c.crop, c.visits, `${c.place ?? ''} ${c.first_visit} a ${c.last_visit}`.trim());
  for (const p of s.pests) add('pragas', p.name, p.times, p.max_level ?? '');
  for (const p of s.products) add('produtos', p.name, p.times);
  for (const m of s.by_subject) add('materias', m.name, m.entries, `${m.reports} relatorios`);
  for (const w of s.weeks) add('semanas', w.start, w.entries);
  return `${BOM}${rows.map((r) => r.map(cell).join(';')).join('\r\n')}\r\n`;
}
