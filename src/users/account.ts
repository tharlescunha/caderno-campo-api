import type { Pool, RowDataPacket } from 'mysql2/promise';
import { inTransaction, type Db } from '../lib/common.js';
import type { MediaStorage } from '../media/storage.js';

// Tables of the user's data. `senha_hash`, tokens and push tokens are never exported.
const EXPORT_TABLES = [
  'periodo',
  'professor',
  'materia',
  'tag',
  'relatorio',
  'registro',
  'registro_pendencia',
  'evento',
  'anotacao',
  'foto',
  'anexo',
  'audio',
  'relatorio_tag',
  'registro_tag',
  'anotacao_tag',
  'notificacao',
] as const;

/** Everything the account has, as rows of the database (docs/banco-de-dados.md). Files are downloaded from their own routes. */
export async function exportAccount(db: Db, userId: string) {
  const [users] = await db.query<RowDataPacket[]>('SELECT * FROM usuario WHERE id = ?', [userId]);
  const { senha_hash: _hash, ...user } = users[0]!;
  void _hash;
  const data: Record<string, RowDataPacket[]> = {};
  for (const table of EXPORT_TABLES) {
    const [rows] = await db.query<RowDataPacket[]>(`SELECT * FROM ${table} WHERE usuario_id = ?`, [userId]);
    data[table] = rows;
  }
  const [days] = await db.query<RowDataPacket[]>(
    'SELECT d.materia_id, d.dia_semana FROM materia_dia d JOIN materia m ON m.id = d.materia_id WHERE m.usuario_id = ?',
    [userId],
  );
  data.materia_dia = days;
  const [devices] = await db.query<RowDataPacket[]>(
    'SELECT id, nome, plataforma, ativo, ultimo_acesso_em, criado_em FROM dispositivo WHERE usuario_id = ?',
    [userId],
  );
  data.dispositivo = devices;
  return { exported_at: new Date().toISOString(), format: 'database-rows', version: 1, user, data };
}

// Children before parents: the composite foreign keys of subject, report and event do not cascade from the user.
const DELETE_ORDER = [
  'notificacao',
  'mudanca',
  'operacao_sync',
  'busca_indice',
  'audio',
  'foto',
  'anexo',
  'registro_tag',
  'anotacao_tag',
  'relatorio_tag',
  'registro_pendencia',
  'registro',
  'evento',
  'relatorio',
  'anotacao',
] as const;
const DELETE_ORDER_AFTER_SUBJECTS = ['materia', 'professor', 'tag', 'periodo', 'dispositivo', 'refresh_token'] as const;

/** Deletes the account and everything in it, rows first, then the user's folder of files. */
export async function deleteAccount(pool: Pool, media: MediaStorage, userId: string): Promise<void> {
  await inTransaction(pool, async (tx) => {
    for (const table of DELETE_ORDER) await tx.query(`DELETE FROM ${table} WHERE usuario_id = ?`, [userId]);
    await tx.query('DELETE d FROM materia_dia d JOIN materia m ON m.id = d.materia_id WHERE m.usuario_id = ?', [userId]);
    for (const table of DELETE_ORDER_AFTER_SUBJECTS) await tx.query(`DELETE FROM ${table} WHERE usuario_id = ?`, [userId]);
    await tx.query('DELETE FROM usuario WHERE id = ?', [userId]);
  });
  // only after the rows are gone: a failure above leaves the files in place
  await media.removeUserFolder(userId);
}
