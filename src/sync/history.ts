import type { RowDataPacket } from 'mysql2/promise';
import type { Db } from '../lib/common.js';
import { isoDate } from '../users/user.js';

export interface TextHistory {
  field: string;
  text: string;
  replaced_at: string | null;
}

/** Texts that lost an edit conflict, newest first, per item (docs/offline.md, section 4). */
export async function fetchHistory(db: Db, userId: string, entity: 'note' | 'entry', ids: string[]): Promise<Map<string, TextHistory[]>> {
  const map = new Map<string, TextHistory[]>();
  if (!ids.length) return map;
  const [rows] = await db.query<RowDataPacket[]>(
    'SELECT entidade_id, campo, texto, substituido_em FROM historico_texto WHERE usuario_id = ? AND entidade = ? AND entidade_id IN (?) ORDER BY substituido_em DESC, id',
    [userId, entity, ids],
  );
  for (const r of rows) {
    const list = map.get(r.entidade_id as string) ?? [];
    list.push({ field: r.campo as string, text: r.texto as string, replaced_at: isoDate(r.substituido_em as string) });
    map.set(r.entidade_id as string, list);
  }
  return map;
}
