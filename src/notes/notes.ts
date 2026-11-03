import type { RowDataPacket } from 'mysql2/promise';
import { fetchAudios, type AudioItem } from '../audios/audios.js';
import { ApiError } from '../http/errors.js';
import { subjectColor, type Db } from '../lib/common.js';
import { loadTags } from '../lib/tags.js';
import { fetchHistory, type TextHistory } from '../sync/history.js';
import { isoDate } from '../users/user.js';

export const MAX_ATTACHMENTS_PER_NOTE = 20;
export const EXCERPT_LENGTH = 160;

export function serializeAttachment(r: RowDataPacket) {
  return {
    id: r.id as string,
    note_id: r.anotacao_id as string,
    mime_type: r.tipo_mime as string,
    size_bytes: r.tamanho_bytes as number,
    url: `/api/v1/attachments/${r.id}`,
    thumbnail_url: r.miniatura ? `/api/v1/attachments/${r.id}/thumbnail` : null,
    created_at: isoDate(r.criado_em as string),
  };
}

export type AttachmentItem = ReturnType<typeof serializeAttachment>;

export async function fetchAttachments(db: Db, userId: string, where: string, params: unknown[]): Promise<AttachmentItem[]> {
  const [rows] = await db.query<RowDataPacket[]>(`SELECT * FROM anexo WHERE usuario_id = ? AND ${where} ORDER BY criado_em, id`, [
    userId,
    ...params,
  ]);
  return rows.map(serializeAttachment);
}

export async function findAttachmentRow(db: Db, userId: string, id: string): Promise<RowDataPacket> {
  const [rows] = await db.query<RowDataPacket[]>('SELECT * FROM anexo WHERE usuario_id = ? AND id = ?', [userId, id]);
  if (!rows[0]) throw new ApiError(404, 'not_found', 'Attachment not found.');
  return rows[0];
}

export async function attachmentFiles(db: Db, userId: string, where: string, params: unknown[]): Promise<string[]> {
  const [rows] = await db.query<RowDataPacket[]>(`SELECT arquivo, miniatura FROM anexo WHERE usuario_id = ? AND ${where}`, [
    userId,
    ...params,
  ]);
  return rows.flatMap((r) => [r.arquivo as string | null, r.miniatura as string | null]).filter((p): p is string => !!p);
}

const SELECT = `
  SELECT a.id, a.titulo, a.texto, a.link, a.fixada, a.criado_em, a.atualizado_em, a.versao,
         m.id AS subject_id, m.nome AS subject_name, m.cor AS subject_color, m.periodo_id AS period_id
    FROM anotacao a LEFT JOIN materia m ON m.usuario_id = a.usuario_id AND m.id = a.materia_id`;

function excerpt(text: string | null): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_LENGTH ? `${flat.slice(0, EXCERPT_LENGTH - 1)}…` : flat;
}

/** Notes of the user: pinned first, then the most recently changed. Without `full` it is the list item. */
export async function fetchNotes(
  db: Db,
  userId: string,
  filter: { sql: string; params: unknown[] },
  options: { paging?: { limit: number; offset: number }; full?: boolean } = {},
) {
  const { paging, full } = options;
  const [rows] = await db.query<RowDataPacket[]>(
    `${SELECT} WHERE a.usuario_id = ? AND ${filter.sql} ORDER BY a.fixada DESC, a.atualizado_em DESC, a.id${paging ? ' LIMIT ? OFFSET ?' : ''}`,
    [userId, ...filter.params, ...(paging ? [paging.limit, paging.offset] : [])],
  );
  const ids = rows.map((r) => r.id as string);
  const tags = await loadTags(db, userId, { table: 'anotacao_tag', owner: 'anotacao_id' }, ids);
  const attachments = new Map<string, AttachmentItem[]>();
  const audios = new Map<string, AudioItem[]>();
  const history = full ? await fetchHistory(db, userId, 'note', ids) : new Map();
  if (full && ids.length) {
    for (const a of await fetchAttachments(db, userId, 'anotacao_id IN (?)', [ids]))
      attachments.set(a.note_id, [...(attachments.get(a.note_id) ?? []), a]);
    for (const a of await fetchAudios(db, userId, 'anotacao_id IN (?)', [ids]))
      audios.set(a.note_id!, [...(audios.get(a.note_id!) ?? []), a]);
  }
  return rows.map((r) => ({
    id: r.id as string,
    title: r.titulo as string,
    excerpt: excerpt(r.texto as string | null),
    subject: r.subject_id
      ? { id: r.subject_id as string, name: r.subject_name as string, color: subjectColor.toApi(r.subject_color as string) }
      : null,
    period_id: (r.period_id as string | null) ?? null,
    tags: tags.get(r.id as string) ?? [],
    pinned: r.fixada === 1,
    link: (r.link as string | null) ?? null,
    updated_at: isoDate(r.atualizado_em as string),
    ...(full
      ? {
          text: (r.texto as string | null) ?? null,
          attachments: attachments.get(r.id as string) ?? [],
          audios: audios.get(r.id as string) ?? [],
          text_history: history.get(r.id as string) ?? [],
          created_at: isoDate(r.criado_em as string),
          version: r.versao as number,
        }
      : {}),
  }));
}

export async function findNote(db: Db, userId: string, id: string) {
  const [note] = await fetchNotes(db, userId, { sql: 'a.id = ?', params: [id] }, { full: true });
  if (!note) throw new ApiError(404, 'not_found', 'Note not found.');
  return note as typeof note & {
    text: string | null;
    attachments: AttachmentItem[];
    audios: AudioItem[];
    text_history: TextHistory[];
    created_at: string | null;
    version: number;
  };
}
