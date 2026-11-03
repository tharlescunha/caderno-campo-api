import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import type { Db } from './common.js';

export const tagNames = z.array(z.string().trim().min(1).max(60)).max(20);

type Link =
  | { table: 'relatorio_tag'; owner: 'relatorio_id' }
  | { table: 'registro_tag'; owner: 'registro_id' }
  | { table: 'anotacao_tag'; owner: 'anotacao_id' };

/** Replaces the tags of one item. Tag names are unique per user (case and accent insensitive, by collation). */
const PARENT: Record<Link['table'], string> = { relatorio_tag: 'relatorio', registro_tag: 'registro', anotacao_tag: 'anotacao' };

export async function setTags(db: Db, userId: string, link: Link, ownerId: string, names: string[], touch = true): Promise<void> {
  // on an edit, a tag change is a change of the item: touch it so its `versao` goes up (the BEFORE UPDATE trigger does it)
  if (touch) await db.query(`UPDATE ${PARENT[link.table]} SET versao = versao WHERE usuario_id = ? AND id = ?`, [userId, ownerId]);
  await db.query(`DELETE FROM ${link.table} WHERE usuario_id = ? AND ${link.owner} = ?`, [userId, ownerId]);
  for (const name of new Set(names)) {
    await db.query('INSERT IGNORE INTO tag (id, usuario_id, nome) VALUES (?, ?, ?)', [randomUUID(), userId, name]);
    const [rows] = await db.query<RowDataPacket[]>('SELECT id FROM tag WHERE usuario_id = ? AND nome = ?', [userId, name]);
    await db.query(`INSERT IGNORE INTO ${link.table} (usuario_id, ${link.owner}, tag_id) VALUES (?, ?, ?)`, [userId, ownerId, rows[0]?.id]);
  }
}

/** Tag names of many items at once: owner id -> names. */
export async function loadTags(db: Db, userId: string, link: Link, ownerIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!ownerIds.length) return map;
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT l.${link.owner} AS owner_id, t.nome FROM ${link.table} l JOIN tag t ON t.usuario_id = l.usuario_id AND t.id = l.tag_id
      WHERE l.usuario_id = ? AND l.${link.owner} IN (?) ORDER BY t.nome`,
    [userId, ownerIds],
  );
  for (const r of rows) map.set(r.owner_id as string, [...(map.get(r.owner_id as string) ?? []), r.nome as string]);
  return map;
}
