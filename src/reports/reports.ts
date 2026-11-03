import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { ApiError } from '../http/errors.js';
import { deliveryFormat, finishedBy, reminder, reportStatus, reportType, subjectColor, type Db } from '../lib/common.js';
import { loadTags } from '../lib/tags.js';
import { indexEvent, removeFromIndex } from '../search/index.js';
import { isoDate } from '../users/user.js';

export interface ReportFilter {
  sql: string;
  params: unknown[];
}

const SELECT = `
  SELECT r.id, r.titulo, r.tipo, r.status, r.finalizado_em, r.finalizado_por, r.data_entrega, r.lembrete_entrega, r.formato_entrega, r.observacoes,
         r.area_foto_id, r.capa_foto_id, r.area_cultura, r.area_local, r.area_comprimento_m, r.area_largura_m, r.area_m2, r.criado_em, r.atualizado_em, r.versao,
         m.id AS subject_id, m.nome AS subject_name, m.cor AS subject_color, m.periodo_id AS period_id,
         (SELECT COUNT(*) FROM registro g WHERE g.usuario_id = r.usuario_id AND g.relatorio_id = r.id) AS n_entries,
         (SELECT MAX(g.data_hora) FROM registro g WHERE g.usuario_id = r.usuario_id AND g.relatorio_id = r.id) AS last_entry_at,
         (SELECT e.id FROM evento e WHERE e.usuario_id = r.usuario_id AND e.relatorio_id = r.id) AS delivery_event_id,
         COALESCE((SELECT f.id FROM foto f WHERE f.usuario_id = r.usuario_id AND f.id = r.capa_foto_id AND f.miniatura IS NOT NULL),
                  (SELECT f.id FROM foto f WHERE f.usuario_id = r.usuario_id AND f.id = r.area_foto_id AND f.miniatura IS NOT NULL),
                  (SELECT f.id FROM foto f JOIN registro g ON g.usuario_id = f.usuario_id AND g.id = f.registro_id
                    WHERE g.usuario_id = r.usuario_id AND g.relatorio_id = r.id AND f.miniatura IS NOT NULL ORDER BY f.criado_em DESC LIMIT 1)) AS cover_photo_id
    FROM relatorio r JOIN materia m ON m.usuario_id = r.usuario_id AND m.id = r.materia_id`;

/** Reports of the user, filtered by the caller. Ordered by the most recent entry. */
export async function fetchReports(db: Db, userId: string, filter: ReportFilter, paging?: { limit: number; offset: number }) {
  const [rows] = await db.query<RowDataPacket[]>(
    `${SELECT} WHERE r.usuario_id = ? AND ${filter.sql}
      ORDER BY (SELECT MAX(g.data_hora) FROM registro g WHERE g.usuario_id = r.usuario_id AND g.relatorio_id = r.id) IS NULL,
               (SELECT MAX(g.data_hora) FROM registro g WHERE g.usuario_id = r.usuario_id AND g.relatorio_id = r.id) DESC, r.criado_em DESC
      ${paging ? 'LIMIT ? OFFSET ?' : ''}`,
    [userId, ...filter.params, ...(paging ? [paging.limit, paging.offset] : [])],
  );
  const tags = await loadTags(
    db,
    userId,
    { table: 'relatorio_tag', owner: 'relatorio_id' },
    rows.map((r) => r.id as string),
  );
  return rows.map((r) => ({
    id: r.id as string,
    title: r.titulo as string,
    type: reportType.toApi(r.tipo as string),
    status: reportStatus.toApi(r.status as string),
    finished_at: isoDate(r.finalizado_em as string | null),
    finished_by: r.finalizado_por ? finishedBy.toApi(r.finalizado_por as string) : null,
    subject: { id: r.subject_id as string, name: r.subject_name as string, color: subjectColor.toApi(r.subject_color as string) },
    period_id: r.period_id as string,
    area:
      r.tipo === 'continuo' && (r.area_cultura || r.area_local || r.area_comprimento_m)
        ? {
            crop: (r.area_cultura as string | null) ?? null,
            place: (r.area_local as string | null) ?? null,
            length_m: r.area_comprimento_m == null ? null : Number(r.area_comprimento_m),
            width_m: r.area_largura_m == null ? null : Number(r.area_largura_m),
            area_m2: r.area_m2 == null ? null : Number(r.area_m2),
          }
        : null,
    delivery_date: (r.data_entrega as string | null) ?? null,
    delivery_reminder: reminder.toApi(r.lembrete_entrega as string),
    delivery_format: r.formato_entrega ? deliveryFormat.toApi(r.formato_entrega as string) : null,
    delivery_event_id: (r.delivery_event_id as string | null) ?? null,
    cover_photo: r.cover_photo_id
      ? { id: r.cover_photo_id as string, thumbnail_url: `/api/v1/photos/${r.cover_photo_id}/thumbnail` }
      : null,
    area_photo_id: (r.area_foto_id as string | null) ?? null,
    chosen_cover_photo_id: (r.capa_foto_id as string | null) ?? null,
    notes: (r.observacoes as string | null) ?? null,
    tags: tags.get(r.id as string) ?? [],
    totals: { entries: Number(r.n_entries) },
    last_entry_at: isoDate(r.last_entry_at as string | null),
    created_at: isoDate(r.criado_em as string),
    updated_at: isoDate(r.atualizado_em as string),
    version: r.versao as number,
  }));
}

export type ReportItem = Awaited<ReturnType<typeof fetchReports>>[number];

export async function findReport(db: Db, userId: string, id: string): Promise<ReportItem & { subject_period_status: string }> {
  const [item] = await fetchReports(db, userId, { sql: 'r.id = ?', params: [id] });
  if (!item) throw new ApiError(404, 'not_found', 'Report not found.');
  const [period] = await db.query<RowDataPacket[]>('SELECT status FROM periodo WHERE usuario_id = ? AND id = ?', [userId, item.period_id]);
  return { ...item, subject_period_status: period[0]?.status as string };
}

/** Reports (and their entries) of a finished period are read-only. */
export function assertPeriodOpen(report: { subject_period_status: string }): void {
  if (report.subject_period_status !== 'ativo') throw new ApiError(409, 'period_finished', 'Finished periods are read-only.');
}

/** Entries can only change while the report is in progress (reopen it first). */
export function assertReportOpen(report: { status: string; subject_period_status: string }): void {
  assertPeriodOpen(report);
  if (report.status === 'finished') throw new ApiError(409, 'report_finished', 'This report is finished. Reopen it first.');
}

/**
 * Keeps the single `entrega_relatorio` event of a report in sync (docs/api.md, section 7):
 * created or updated when there is a delivery date, removed when there is none.
 */
export async function syncDeliveryEvent(
  db: Db,
  userId: string,
  report: { id: string; title: string; subjectId: string },
  deliveryDate: string | null,
  deliveryReminder: string,
): Promise<void> {
  if (!deliveryDate) {
    const [gone] = await db.query<RowDataPacket[]>('SELECT id FROM evento WHERE usuario_id = ? AND relatorio_id = ?', [userId, report.id]);
    await db.query('DELETE FROM evento WHERE usuario_id = ? AND relatorio_id = ?', [userId, report.id]);
    await removeFromIndex(
      db,
      'evento',
      gone.map((r) => r.id as string),
    );
    return;
  }
  const title = `Entrega do relatório: ${report.title}`.slice(0, 160);
  const [existing] = await db.query<RowDataPacket[]>('SELECT id FROM evento WHERE usuario_id = ? AND relatorio_id = ?', [
    userId,
    report.id,
  ]);
  if (existing[0]) {
    await db.query(
      'UPDATE evento SET titulo = ?, data = ?, lembrete = ?, materia_id = ?, encerrado_com_periodo = 0 WHERE usuario_id = ? AND id = ?',
      [title, deliveryDate, reminder.toDb(deliveryReminder as never), report.subjectId, userId, existing[0].id],
    );
  } else {
    await db.query(
      "INSERT INTO evento (id, usuario_id, materia_id, relatorio_id, tipo, titulo, data, lembrete) VALUES (?, ?, ?, ?, 'entrega_relatorio', ?, ?, ?)",
      [randomUUID(), userId, report.subjectId, report.id, title, deliveryDate, reminder.toDb(deliveryReminder as never)],
    );
  }
  const [now] = await db.query<RowDataPacket[]>('SELECT id FROM evento WHERE usuario_id = ? AND relatorio_id = ?', [userId, report.id]);
  if (now[0]) await indexEvent(db, userId, now[0].id as string);
}
