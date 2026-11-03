import type { RowDataPacket } from 'mysql2/promise';
import { ApiError } from '../http/errors.js';
import { classType, eventType, subjectColor, type Db } from '../lib/common.js';
import { isoDate } from '../users/user.js';

export interface SubjectFilter {
  sql: string;
  params: unknown[];
}

/** Subjects with weekdays, teacher, counters and next exam/deadline, filtered by the caller (always scoped to the user). */
export async function fetchSubjects(
  db: Db,
  userId: string,
  today: string,
  filter: SubjectFilter,
  paging?: { limit: number; offset: number },
) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT m.id, m.periodo_id, m.nome, m.tipo_aula, m.cor, m.lembrar_vespera, m.desativada, m.criado_em, m.atualizado_em, m.versao,
            pr.id AS teacher_id, pr.nome AS teacher_name,
            (SELECT COUNT(*) FROM relatorio r WHERE r.usuario_id = m.usuario_id AND r.materia_id = m.id) AS n_reports,
            (SELECT COUNT(*) FROM anotacao a WHERE a.usuario_id = m.usuario_id AND a.materia_id = m.id) AS n_notes,
            ne.tipo AS next_type, ne.data AS next_date, ne.titulo AS next_title
       FROM materia m
       LEFT JOIN professor pr ON pr.usuario_id = m.usuario_id AND pr.id = m.professor_id
       LEFT JOIN evento ne ON ne.id = (
              SELECT e.id FROM evento e
               WHERE e.usuario_id = m.usuario_id AND e.materia_id = m.id AND e.concluido = 0 AND e.encerrado_com_periodo = 0 AND e.data >= ?
               ORDER BY e.data LIMIT 1)
      WHERE m.usuario_id = ? AND ${filter.sql}
      ORDER BY m.nome${paging ? ' LIMIT ? OFFSET ?' : ''}`,
    [today, userId, ...filter.params, ...(paging ? [paging.limit, paging.offset] : [])],
  );

  const days = new Map<string, number[]>();
  if (rows.length) {
    const [dayRows] = await db.query<RowDataPacket[]>(
      'SELECT materia_id, dia_semana FROM materia_dia WHERE materia_id IN (?) ORDER BY dia_semana',
      [rows.map((r) => r.id)],
    );
    for (const d of dayRows) days.set(d.materia_id as string, [...(days.get(d.materia_id as string) ?? []), d.dia_semana as number]);
  }

  return rows.map((r) => ({
    id: r.id as string,
    period_id: r.periodo_id as string,
    name: r.nome as string,
    class_type: classType.toApi(r.tipo_aula as string),
    color: subjectColor.toApi(r.cor as string),
    weekdays: days.get(r.id as string) ?? [],
    remind_eve: r.lembrar_vespera === 1,
    deactivated: r.desativada === 1,
    teacher: r.teacher_id ? { id: r.teacher_id as string, name: r.teacher_name as string } : null,
    totals: { reports: Number(r.n_reports), notes: Number(r.n_notes) },
    next_date: r.next_date
      ? { type: eventType.toApi(r.next_type as string), date: r.next_date as string, title: r.next_title as string }
      : null,
    created_at: isoDate(r.criado_em as string),
    updated_at: isoDate(r.atualizado_em as string),
    version: r.versao as number,
  }));
}

export type SubjectItem = Awaited<ReturnType<typeof fetchSubjects>>[number];

export async function findSubject(db: Db, userId: string, today: string, id: string): Promise<SubjectItem> {
  const [item] = await fetchSubjects(db, userId, today, { sql: 'm.id = ?', params: [id] });
  if (!item) throw new ApiError(404, 'not_found', 'Subject not found.');
  return item;
}

/** The teacher must be the user's own, otherwise 422 on `teacher_id`. */
export async function checkTeacher(db: Db, userId: string, teacherId: string | null | undefined): Promise<void> {
  if (!teacherId) return;
  const [rows] = await db.query<RowDataPacket[]>('SELECT 1 FROM professor WHERE usuario_id = ? AND id = ?', [userId, teacherId]);
  if (!rows[0]) throw new ApiError(422, 'validation', 'Some fields are invalid.', [{ field: 'teacher_id', message: 'Teacher not found.' }]);
}

export async function replaceWeekdays(db: Db, subjectId: string, weekdays: number[]): Promise<void> {
  await db.query('DELETE FROM materia_dia WHERE materia_id = ?', [subjectId]);
  await db.query('INSERT INTO materia_dia (materia_id, dia_semana) VALUES ?', [weekdays.map((d) => [subjectId, d])]);
}
