import type { RowDataPacket } from 'mysql2/promise';
import { ApiError } from '../http/errors.js';
import type { Db } from '../lib/common.js';
import { isoDate } from '../users/user.js';

export const PERIOD_COLUMNS = 'id, nome, data_inicio, data_fim, status, finalizado_em, criado_em, atualizado_em, versao';

export function serializePeriod(r: RowDataPacket) {
  return {
    id: r.id as string,
    name: r.nome as string,
    start_date: r.data_inicio as string,
    end_date: (r.data_fim as string | null) ?? null,
    status: r.status === 'ativo' ? 'active' : 'finished',
    finished_at: isoDate(r.finalizado_em as string | null),
    created_at: isoDate(r.criado_em as string),
    updated_at: isoDate(r.atualizado_em as string),
    version: r.versao as number,
  };
}

/** The period, only if it belongs to the user (otherwise 404, never revealing it exists). */
export async function findPeriod(db: Db, userId: string, id: string, forUpdate = false): Promise<RowDataPacket> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${PERIOD_COLUMNS} FROM periodo WHERE usuario_id = ? AND id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [userId, id],
  );
  if (!rows[0]) throw new ApiError(404, 'not_found', 'Period not found.');
  return rows[0];
}

export async function findActivePeriod(db: Db, userId: string): Promise<RowDataPacket | null> {
  const [rows] = await db.query<RowDataPacket[]>(`SELECT ${PERIOD_COLUMNS} FROM periodo WHERE usuario_id = ? AND status = 'ativo'`, [
    userId,
  ]);
  return rows[0] ?? null;
}

async function count(db: Db, sql: string, params: unknown[]): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

/** What closing the period would do and what stays (docs/api.md, section 6). Changes nothing. */
export async function closingPreview(db: Db, userId: string, period: RowDataPacket, today: string) {
  const inPeriod = 'm.usuario_id = ? AND m.periodo_id = ?';
  const p = [userId, period.id];
  const subjects = await count(db, `SELECT COUNT(*) AS n FROM materia m WHERE ${inPeriod}`, p);
  const reportsInProgress = await count(
    db,
    `SELECT COUNT(*) AS n FROM relatorio r JOIN materia m ON m.usuario_id = r.usuario_id AND m.id = r.materia_id WHERE ${inPeriod} AND r.status = 'em_andamento'`,
    p,
  );
  const futureEvents = await count(
    db,
    `SELECT COUNT(*) AS n FROM evento e JOIN materia m ON m.usuario_id = e.usuario_id AND m.id = e.materia_id WHERE ${inPeriod} AND e.data >= ? AND e.encerrado_com_periodo = 0`,
    [...p, today],
  );
  const reports = await count(
    db,
    `SELECT COUNT(*) AS n FROM relatorio r JOIN materia m ON m.usuario_id = r.usuario_id AND m.id = r.materia_id WHERE ${inPeriod}`,
    p,
  );
  const entryJoin =
    'FROM registro g JOIN relatorio r ON r.usuario_id = g.usuario_id AND r.id = g.relatorio_id JOIN materia m ON m.usuario_id = r.usuario_id AND m.id = r.materia_id';
  const entries = await count(db, `SELECT COUNT(*) AS n ${entryJoin} WHERE ${inPeriod}`, p);
  const drafts = await count(db, `SELECT COUNT(*) AS n ${entryJoin} WHERE ${inPeriod} AND g.status = 'rascunho'`, p);
  const photos = await count(
    db,
    `SELECT COUNT(*) AS n FROM foto f JOIN registro g ON g.usuario_id = f.usuario_id AND g.id = f.registro_id JOIN relatorio r ON r.usuario_id = g.usuario_id AND r.id = g.relatorio_id JOIN materia m ON m.usuario_id = r.usuario_id AND m.id = r.materia_id WHERE ${inPeriod}`,
    p,
  );
  const notes = await count(
    db,
    `SELECT COUNT(*) AS n FROM anotacao a JOIN materia m ON m.usuario_id = a.usuario_id AND m.id = a.materia_id WHERE ${inPeriod}`,
    p,
  );
  return {
    period: { id: period.id as string, name: period.nome as string },
    will_close: { subjects, reports_in_progress: reportsInProgress, future_events: futureEvents },
    will_keep: { reports, entries, photos, notes },
    warnings: drafts > 0 ? [`${drafts} draft ${drafts === 1 ? 'entry stays a draft' : 'entries stay drafts'} and become read-only.`] : [],
  };
}

/**
 * Closes the period. Call inside a transaction; nothing is deleted (docs/api.md, section 6):
 * period finished, reports in progress finished, future events hidden, pending notifications cancelled.
 */
export async function closePeriod(db: Db, userId: string, periodId: string, today: string): Promise<void> {
  await db.query(
    `UPDATE periodo SET status = 'finalizado', finalizado_em = NOW(3), data_fim = GREATEST(COALESCE(data_fim, ?), data_inicio)
     WHERE usuario_id = ? AND id = ?`,
    [today, userId, periodId],
  );
  const subjectIds = 'SELECT id FROM materia WHERE usuario_id = ? AND periodo_id = ?';
  await db.query(
    `UPDATE relatorio SET status = 'finalizado', finalizado_em = NOW(3), finalizado_por = 'periodo'
     WHERE usuario_id = ? AND status = 'em_andamento' AND materia_id IN (${subjectIds})`,
    [userId, userId, periodId],
  );
  await db.query(
    `UPDATE notificacao SET cancelada_em = NOW(3)
     WHERE usuario_id = ? AND enviada_em IS NULL AND cancelada_em IS NULL AND referencia_tipo = 'evento'
       AND referencia_id IN (SELECT id FROM evento WHERE usuario_id = ? AND data >= ? AND materia_id IN (${subjectIds}))`,
    [userId, userId, today, userId, periodId],
  );
  await db.query(
    `UPDATE evento SET encerrado_com_periodo = 1
     WHERE usuario_id = ? AND data >= ? AND encerrado_com_periodo = 0 AND materia_id IN (${subjectIds})`,
    [userId, today, userId, periodId],
  );
}
