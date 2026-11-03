import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { uuid } from '../lib/common.js';
import { isoDate } from '../users/user.js';
import { ApiError, validate } from './errors.js';
import { requireAuth } from './require-auth.js';

export const createBody = z.object({
  id: uuid.optional(),
  push_token: z.string().trim().min(1, 'Send the push token.').max(255),
  platform: z.enum(['android', 'ios', 'web']),
  name: z.string().trim().min(1).max(120).nullable().optional(),
});

function serialize(r: RowDataPacket) {
  return {
    id: r.id as string,
    name: (r.nome as string | null) ?? null,
    platform: r.plataforma as 'android' | 'ios' | 'web',
    active: r.ativo === 1,
    last_seen_at: isoDate(r.ultimo_acesso_em as string | null),
    created_at: isoDate(r.criado_em as string),
  };
}

export const deviceRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const { pool } = ctx;
    app.addHook('preHandler', requireAuth(ctx));

    // Registers the phone for push. The same token again just refreshes the record; a token that was on
    // another account (the phone changed hands) moves to this one, so it never receives two accounts' reminders.
    app.post('/devices', async (req, reply) => {
      const b = validate(createBody, req.body);
      await pool.query('DELETE FROM dispositivo WHERE token_push = ? AND usuario_id <> ?', [b.push_token, req.userId]);
      const [same] = await pool.query<RowDataPacket[]>('SELECT id FROM dispositivo WHERE usuario_id = ? AND token_push = ?', [
        req.userId,
        b.push_token,
      ]);
      const id = (same[0]?.id as string | undefined) ?? b.id ?? randomUUID();
      await pool.query(
        `INSERT INTO dispositivo (id, usuario_id, nome, token_push, plataforma, ativo, ultimo_acesso_em) VALUES (?, ?, ?, ?, ?, 1, NOW(3))
         ON DUPLICATE KEY UPDATE nome = COALESCE(VALUES(nome), nome), token_push = VALUES(token_push), plataforma = VALUES(plataforma), ativo = 1, ultimo_acesso_em = NOW(3)`,
        [id, req.userId, b.name ?? null, b.push_token, b.platform],
      );
      const [rows] = await pool.query<RowDataPacket[]>('SELECT * FROM dispositivo WHERE usuario_id = ? AND id = ?', [req.userId, id]);
      return reply.status(same[0] ? 200 : 201).send(serialize(rows[0]!));
    });

    app.delete<{ Params: { id: string } }>('/devices/:id', async (req, reply) => {
      const id = validate(uuid, req.params.id);
      const [result] = await pool.query<{ affectedRows: number } & RowDataPacket[]>(
        'DELETE FROM dispositivo WHERE usuario_id = ? AND id = ?',
        [req.userId, id],
      );
      if (!result.affectedRows) throw new ApiError(404, 'not_found', 'Device not found.');
      return reply.status(204).send();
    });
  };
