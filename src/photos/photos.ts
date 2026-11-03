import type { RowDataPacket } from 'mysql2/promise';
import { ApiError } from '../http/errors.js';
import type { Db } from '../lib/common.js';
import type { MediaStorage } from '../media/storage.js';
import { isoDate } from '../users/user.js';

export const MAX_PHOTOS_PER_PARENT = 20;

const URL_BASE = '/api/v1/photos';

export function serializePhoto(r: RowDataPacket) {
  return {
    id: r.id as string,
    entry_id: (r.registro_id as string | null) ?? null,
    report_id: (r.relatorio_id as string | null) ?? null,
    event_id: (r.evento_id as string | null) ?? null,
    caption: (r.legenda as string | null) ?? null,
    taken_at: isoDate(r.tirada_em as string | null),
    latitude: r.latitude == null ? null : Number(r.latitude),
    longitude: r.longitude == null ? null : Number(r.longitude),
    mime_type: r.tipo_mime as string,
    size_bytes: r.tamanho_bytes as number,
    url: `${URL_BASE}/${r.id}`,
    thumbnail_url: r.miniatura ? `${URL_BASE}/${r.id}/thumbnail` : null,
    created_at: isoDate(r.criado_em as string),
    updated_at: isoDate(r.atualizado_em as string),
    version: r.versao as number,
  };
}

export type PhotoItem = ReturnType<typeof serializePhoto>;

export async function fetchPhotos(db: Db, userId: string, where: string, params: unknown[]): Promise<PhotoItem[]> {
  const [rows] = await db.query<RowDataPacket[]>(`SELECT * FROM foto WHERE usuario_id = ? AND ${where} ORDER BY criado_em, id`, [
    userId,
    ...params,
  ]);
  return rows.map(serializePhoto);
}

export async function findPhotoRow(db: Db, userId: string, id: string): Promise<RowDataPacket> {
  const [rows] = await db.query<RowDataPacket[]>('SELECT * FROM foto WHERE usuario_id = ? AND id = ?', [userId, id]);
  if (!rows[0]) throw new ApiError(404, 'not_found', 'Photo not found.');
  return rows[0];
}

/** Files (original and thumbnail) of the photos matching `where`; call before deleting their parent rows. */
export async function photoFiles(db: Db, userId: string, where: string, params: unknown[]): Promise<string[]> {
  const [rows] = await db.query<RowDataPacket[]>(`SELECT arquivo, miniatura FROM foto WHERE usuario_id = ? AND ${where}`, [
    userId,
    ...params,
  ]);
  return rows.flatMap((r) => [r.arquivo as string | null, r.miniatura as string | null]).filter((p): p is string => !!p);
}

/** Subqueries that select the photos under a report / an entry / an event (for `photoFiles`). */
export const PHOTOS_OF_ENTRY = 'registro_id = ?';
export const PHOTOS_OF_EVENT = 'evento_id = ?';
export const PHOTOS_OF_REPORT =
  '(relatorio_id = ? OR registro_id IN (SELECT id FROM registro WHERE usuario_id = foto.usuario_id AND relatorio_id = ?) ' +
  'OR evento_id IN (SELECT id FROM evento WHERE usuario_id = foto.usuario_id AND relatorio_id = ?))';

export async function removeFiles(media: MediaStorage, files: string[]): Promise<void> {
  await media.remove(files);
}
