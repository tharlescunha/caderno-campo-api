import type { RowDataPacket } from 'mysql2/promise';
import { ApiError } from '../http/errors.js';
import { eventType, reminder, type Db } from '../lib/common.js';
import { isoDate } from '../users/user.js';

export const EVENT_COLUMNS =
  'id, materia_id, relatorio_id, tipo, descricao_tipo, titulo, data, lembrete, anotacoes, concluido, encerrado_com_periodo, criado_em, atualizado_em, versao';

export function serializeEvent(r: RowDataPacket) {
  return {
    id: r.id as string,
    type: eventType.toApi(r.tipo as string),
    type_description: (r.descricao_tipo as string | null) ?? null,
    title: r.titulo as string,
    subject_id: (r.materia_id as string | null) ?? null,
    report_id: (r.relatorio_id as string | null) ?? null,
    date: r.data as string,
    reminder: reminder.toApi(r.lembrete as string),
    notes: (r.anotacoes as string | null) ?? null,
    completed: r.concluido === 1,
    closed_with_period: r.encerrado_com_periodo === 1,
    created_at: isoDate(r.criado_em as string),
    updated_at: isoDate(r.atualizado_em as string),
    version: r.versao as number,
  };
}

export async function findEvent(db: Db, userId: string, id: string): Promise<RowDataPacket> {
  const [rows] = await db.query<RowDataPacket[]>(`SELECT ${EVENT_COLUMNS} FROM evento WHERE usuario_id = ? AND id = ?`, [userId, id]);
  if (!rows[0]) throw new ApiError(404, 'not_found', 'Event not found.');
  return rows[0];
}

/**
 * The subject (if any) must be the user's own and in an active period.
 * 422 on `subject_id` when it does not exist for this user; 409 when its period is finished.
 */
export async function checkEventSubject(db: Db, userId: string, subjectId: string | null | undefined): Promise<void> {
  if (!subjectId) return;
  const [rows] = await db.query<RowDataPacket[]>(
    'SELECT p.status FROM materia m JOIN periodo p ON p.usuario_id = m.usuario_id AND p.id = m.periodo_id WHERE m.usuario_id = ? AND m.id = ?',
    [userId, subjectId],
  );
  if (!rows[0]) throw new ApiError(422, 'validation', 'Some fields are invalid.', [{ field: 'subject_id', message: 'Subject not found.' }]);
  if (rows[0].status !== 'ativo') throw new ApiError(409, 'period_finished', 'Finished periods are read-only.');
}
