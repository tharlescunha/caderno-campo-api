import type { RowDataPacket } from 'mysql2/promise';
import type { Db } from '../lib/common.js';

/**
 * Full-text search index (table `busca_indice`, docs/banco-de-dados.md section 6). The API keeps it up to
 * date on every write, inside the same transaction as the write (no triggers, easy to test).
 * Entity names are the database ones: anotacao, relatorio, registro, materia, evento.
 */
export type Entity = 'anotacao' | 'relatorio' | 'registro' | 'materia' | 'evento';

const ACTIVITY_WORDS: Record<string, string> = {
  adubacao: 'adubação',
  limpeza: 'limpeza',
  vistoria: 'vistoria',
  aplicacao: 'aplicação',
  irrigacao: 'irrigação',
  plantio: 'plantio',
  colheita: 'colheita',
  outro: 'outro',
};

const join = (parts: (string | null | undefined)[]) => parts.filter((p): p is string => !!p && p.trim() !== '').join('\n');

async function tagsOf(db: Db, userId: string, table: string, owner: string, id: string): Promise<string[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT t.nome FROM ${table} l JOIN tag t ON t.usuario_id = l.usuario_id AND t.id = l.tag_id WHERE l.usuario_id = ? AND l.${owner} = ? ORDER BY t.nome`,
    [userId, id],
  );
  return rows.map((r) => r.nome as string);
}

/** What the user said in the audios: the text they fixed, or else the machine one. */
async function transcriptionsOf(db: Db, userId: string, column: 'registro_id' | 'anotacao_id', id: string): Promise<string[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COALESCE(transcricao_editada, transcricao) AS texto FROM audio WHERE usuario_id = ? AND ${column} = ?`,
    [userId, id],
  );
  return rows.map((r) => r.texto as string | null).filter((t): t is string => !!t);
}

async function put(db: Db, userId: string, entity: Entity, id: string, title: string, body: string): Promise<void> {
  await db.query(
    `INSERT INTO busca_indice (usuario_id, entidade, entidade_id, titulo, corpo) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE usuario_id = VALUES(usuario_id), titulo = VALUES(titulo), corpo = VALUES(corpo)`,
    [userId, entity, id, title.slice(0, 190), body],
  );
}

export async function removeFromIndex(db: Db, entity: Entity, ids: string[]): Promise<void> {
  if (ids.length) await db.query('DELETE FROM busca_indice WHERE entidade = ? AND entidade_id IN (?)', [entity, ids]);
}

export async function indexNote(db: Db, userId: string, id: string): Promise<void> {
  const [rows] = await db.query<RowDataPacket[]>('SELECT titulo, texto FROM anotacao WHERE usuario_id = ? AND id = ?', [userId, id]);
  const n = rows[0];
  if (!n) return removeFromIndex(db, 'anotacao', [id]);
  const tags = await tagsOf(db, userId, 'anotacao_tag', 'anotacao_id', id);
  await put(
    db,
    userId,
    'anotacao',
    id,
    n.titulo as string,
    join([n.texto, ...tags, ...(await transcriptionsOf(db, userId, 'anotacao_id', id))]),
  );
}

export async function indexReport(db: Db, userId: string, id: string): Promise<void> {
  const [rows] = await db.query<RowDataPacket[]>(
    'SELECT titulo, observacoes, area_cultura, area_local FROM relatorio WHERE usuario_id = ? AND id = ?',
    [userId, id],
  );
  const r = rows[0];
  if (!r) return removeFromIndex(db, 'relatorio', [id]);
  const tags = await tagsOf(db, userId, 'relatorio_tag', 'relatorio_id', id);
  await put(db, userId, 'relatorio', id, r.titulo as string, join([r.observacoes, r.area_cultura, r.area_local, ...tags]));
}

export async function indexEntry(db: Db, userId: string, id: string): Promise<void> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT g.data_hora, g.atividades, g.aplicacao_produto, g.aplicacao_dose, g.aplicacao_alvo, g.estagio, g.praga_nome, g.observacoes, r.titulo AS relatorio
       FROM registro g JOIN relatorio r ON r.usuario_id = g.usuario_id AND r.id = g.relatorio_id WHERE g.usuario_id = ? AND g.id = ?`,
    [userId, id],
  );
  const g = rows[0];
  if (!g) return removeFromIndex(db, 'registro', [id]);
  const [todos] = await db.query<RowDataPacket[]>(
    'SELECT texto FROM registro_pendencia WHERE usuario_id = ? AND registro_id = ? ORDER BY ordem',
    [userId, id],
  );
  const activities: string[] = (typeof g.atividades === 'string' ? JSON.parse(g.atividades) : g.atividades) ?? [];
  const [date] = (g.data_hora as string).split(' ');
  const [y, m, d] = (date as string).split('-');
  const tags = await tagsOf(db, userId, 'registro_tag', 'registro_id', id);
  await put(
    db,
    userId,
    'registro',
    id,
    `${g.relatorio} · ${d}/${m}/${y}`,
    join([
      g.observacoes,
      g.aplicacao_produto,
      g.aplicacao_dose,
      g.aplicacao_alvo,
      g.praga_nome,
      g.estagio,
      ...activities.map((a) => ACTIVITY_WORDS[a] ?? a),
      ...todos.map((t) => t.texto as string),
      ...tags,
      ...(await transcriptionsOf(db, userId, 'registro_id', id)),
    ]),
  );
}

export async function indexSubject(db: Db, userId: string, id: string): Promise<void> {
  const [rows] = await db.query<RowDataPacket[]>(
    'SELECT m.nome, p.nome AS professor FROM materia m LEFT JOIN professor p ON p.usuario_id = m.usuario_id AND p.id = m.professor_id WHERE m.usuario_id = ? AND m.id = ?',
    [userId, id],
  );
  const m = rows[0];
  if (!m) return removeFromIndex(db, 'materia', [id]);
  await put(db, userId, 'materia', id, m.nome as string, join([m.professor]));
}

export async function indexEvent(db: Db, userId: string, id: string): Promise<void> {
  const [rows] = await db.query<RowDataPacket[]>('SELECT titulo, anotacoes, descricao_tipo FROM evento WHERE usuario_id = ? AND id = ?', [
    userId,
    id,
  ]);
  const e = rows[0];
  if (!e) return removeFromIndex(db, 'evento', [id]);
  await put(db, userId, 'evento', id, e.titulo as string, join([e.anotacoes, e.descricao_tipo]));
}

/** After an audio changes (transcribed, edited, deleted), refresh the item it belongs to. */
export async function indexAudioParent(db: Db, userId: string, parent: { entryId?: string | null; noteId?: string | null }): Promise<void> {
  if (parent.entryId) await indexEntry(db, userId, parent.entryId);
  if (parent.noteId) await indexNote(db, userId, parent.noteId);
}

// ---- search --------------------------------------------------------------------------------------------

export interface SearchHit {
  id: string;
  title: string;
  excerpt: string | null;
  subject: { id: string; name: string } | null;
}

export interface SearchResult {
  notes: SearchHit[];
  reports: SearchHit[];
  entries: SearchHit[];
  subjects: SearchHit[];
  events: SearchHit[];
}

const PER_ENTITY = 5;
const KEY: Record<Entity, keyof SearchResult> = {
  anotacao: 'notes',
  relatorio: 'reports',
  registro: 'entries',
  materia: 'subjects',
  evento: 'events',
};

/** Words of the query, lowercase, without accents (the collation also ignores them), at least 2 letters. */
export function searchTokens(q: string): string[] {
  return q
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2)
    .slice(0, 8);
}

const strip = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '');

/** A piece of the text around the first word found, about 140 characters, with "…" where it was cut. */
export function excerptAround(body: string | null, tokens: string[]): string | null {
  if (!body) return null;
  const flat = body.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  // map char by char so that positions in the plain text match the original
  const plain = [...flat]
    .map((c) => strip(c)[0] ?? c)
    .join('')
    .toLowerCase();
  const positions = tokens.map((t) => plain.indexOf(t)).filter((i) => i >= 0);
  const at = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, at - 50);
  const end = Math.min(flat.length, start + 140);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/** The subject (id, name) each hit belongs to, per entity. */
async function subjectsOf(db: Db, userId: string, entity: Entity, ids: string[]): Promise<Map<string, { id: string; name: string }>> {
  const map = new Map<string, { id: string; name: string }>();
  if (!ids.length) return map;
  const queries: Record<Entity, string> = {
    anotacao:
      'SELECT a.id AS id, m.id AS sid, m.nome AS sname FROM anotacao a JOIN materia m ON m.usuario_id = a.usuario_id AND m.id = a.materia_id WHERE a.usuario_id = ? AND a.id IN (?)',
    relatorio:
      'SELECT r.id AS id, m.id AS sid, m.nome AS sname FROM relatorio r JOIN materia m ON m.usuario_id = r.usuario_id AND m.id = r.materia_id WHERE r.usuario_id = ? AND r.id IN (?)',
    registro:
      'SELECT g.id AS id, m.id AS sid, m.nome AS sname FROM registro g JOIN relatorio r ON r.usuario_id = g.usuario_id AND r.id = g.relatorio_id JOIN materia m ON m.usuario_id = r.usuario_id AND m.id = r.materia_id WHERE g.usuario_id = ? AND g.id IN (?)',
    materia: 'SELECT m.id AS id, m.id AS sid, m.nome AS sname FROM materia m WHERE m.usuario_id = ? AND m.id IN (?)',
    evento:
      'SELECT e.id AS id, m.id AS sid, m.nome AS sname FROM evento e JOIN materia m ON m.usuario_id = e.usuario_id AND m.id = e.materia_id WHERE e.usuario_id = ? AND e.id IN (?)',
  };
  const [rows] = await db.query<RowDataPacket[]>(queries[entity], [userId, ids]);
  for (const r of rows) map.set(r.id as string, { id: r.sid as string, name: r.sname as string });
  return map;
}

export async function search(db: Db, userId: string, q: string): Promise<SearchResult> {
  const result: SearchResult = { notes: [], reports: [], entries: [], subjects: [], events: [] };
  const tokens = searchTokens(q);
  if (!tokens.length) return result;
  // every word has to appear, as the start of a word: "praga lag" finds "praga … lagarta"
  const against = tokens.map((t) => `+${t}*`).join(' ');
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT entidade, entidade_id, titulo, corpo, MATCH(titulo, corpo) AGAINST (? IN BOOLEAN MODE) AS score
       FROM busca_indice WHERE usuario_id = ? AND MATCH(titulo, corpo) AGAINST (? IN BOOLEAN MODE) ORDER BY score DESC LIMIT 200`,
    [against, userId, against],
  );
  const grouped = new Map<Entity, RowDataPacket[]>();
  for (const r of rows) {
    const list = grouped.get(r.entidade as Entity) ?? [];
    if (list.length < PER_ENTITY) list.push(r);
    grouped.set(r.entidade as Entity, list);
  }
  for (const [entity, list] of grouped) {
    const subjects = await subjectsOf(
      db,
      userId,
      entity,
      list.map((r) => r.entidade_id as string),
    );
    result[KEY[entity]] = list.map((r) => ({
      id: r.entidade_id as string,
      title: r.titulo as string,
      excerpt: excerptAround(r.corpo as string | null, tokens),
      subject: subjects.get(r.entidade_id as string) ?? null,
    }));
  }
  return result;
}
