import type { FastifyPluginAsync } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { enumMap, pageOf, pageQuery, uuid } from '../lib/common.js';
import { isoDate } from '../users/user.js';
import { ApiError, validate } from './errors.js';
import { requireAuth } from './require-auth.js';

export const notificationType = enumMap({
  event_reminder: 'lembrete_evento',
  field_class_reminder: 'lembrete_aula_campo',
  delivery_reminder: 'lembrete_entrega',
  post_field_record_reminder: 'lembrete_registro_pos_campo',
});
const referenceType = enumMap({ event: 'evento', report: 'relatorio', subject: 'materia' });

export const listQuery = pageQuery.extend({ unread: z.enum(['true', 'false']).optional() });

// What the inbox shows: reminders that were delivered and not cancelled
const INBOX = 'usuario_id = ? AND enviada_em IS NOT NULL AND cancelada_em IS NULL';

function serialize(r: RowDataPacket) {
  return {
    id: r.id as string,
    type: notificationType.toApi(r.tipo as string),
    title: r.titulo as string,
    text: (r.texto as string | null) ?? null,
    reference: r.referencia_tipo ? { type: referenceType.toApi(r.referencia_tipo as string), id: r.referencia_id as string } : null,
    scheduled_for: isoDate(r.agendada_para as string),
    delivered_at: isoDate(r.enviada_em as string | null),
    read_at: isoDate(r.lida_em as string | null),
    created_at: isoDate(r.criado_em as string),
  };
}

export async function countUnread(pool: AppContext['pool'], userId: string): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM notificacao WHERE ${INBOX} AND lida_em IS NULL`, [userId]);
  return Number(rows[0]?.n ?? 0);
}

export const notificationRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const { pool } = ctx;
    app.addHook('preHandler', requireAuth(ctx));

    // The bell of the Today screen: newest first
    app.get('/notifications', async (req) => {
      const q = validate(listQuery, req.query);
      const unreadOnly = q.unread === 'true' ? ' AND lida_em IS NULL' : '';
      const [count] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM notificacao WHERE ${INBOX}${unreadOnly}`, [req.userId]);
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT * FROM notificacao WHERE ${INBOX}${unreadOnly} ORDER BY agendada_para DESC, id LIMIT ? OFFSET ?`,
        [req.userId, q.limit, (q.page - 1) * q.limit],
      );
      return {
        ...pageOf(rows.map(serialize), q.page, q.limit, Number(count[0]?.n ?? 0)),
        unread_count: await countUnread(pool, req.userId),
      };
    });

    app.patch<{ Params: { id: string } }>('/notifications/:id/read', async (req) => {
      const id = validate(uuid, req.params.id);
      const [rows] = await pool.query<RowDataPacket[]>(`SELECT * FROM notificacao WHERE ${INBOX} AND id = ?`, [req.userId, id]);
      if (!rows[0]) throw new ApiError(404, 'not_found', 'Notification not found.');
      await pool.query('UPDATE notificacao SET lida_em = COALESCE(lida_em, NOW(3)) WHERE usuario_id = ? AND id = ?', [req.userId, id]);
      const [after] = await pool.query<RowDataPacket[]>('SELECT * FROM notificacao WHERE usuario_id = ? AND id = ?', [req.userId, id]);
      return serialize(after[0]!);
    });

    app.post('/notifications/read-all', async (req) => {
      const [result] = await pool.query<{ affectedRows: number } & RowDataPacket[]>(
        `UPDATE notificacao SET lida_em = NOW(3) WHERE ${INBOX} AND lida_em IS NULL`,
        [req.userId],
      );
      return { marked: result.affectedRows, unread_count: 0 };
    });
  };
