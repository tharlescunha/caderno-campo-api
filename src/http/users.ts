import type { FastifyPluginAsync } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { checkPassword, hashPassword } from '../auth/crypto.js';
import type { AppContext } from '../context.js';
import { serializeUser, THEME_IN, USER_COLUMNS } from '../users/user.js';
import { ApiError, validate } from './errors.js';
import { requireAuth } from './require-auth.js';

export const patchBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    course: z.string().trim().max(120).nullable(),
    institution: z.string().trim().max(120).nullable(),
    timezone: z.string().trim().min(1).max(60),
    theme: z.enum(['light', 'dark', 'system']),
    default_location: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).nullable(),
    first_access_completed: z.literal(true),
    notify_exams_and_deadlines: z.boolean(),
    notify_field_class_eve: z.boolean(),
    notify_report_deadline: z.boolean(),
    remind_record_after_field: z.boolean(),
    remind_record_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM.'),
    delete_audio_after_transcription: z.boolean(),
  })
  .partial()
  .strict();

export const passwordBody = z.object({
  current_password: z.string().min(1, 'Enter the current password.'),
  new_password: z.string().min(8, 'The password needs at least 8 characters.').max(200),
});

export const userRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const { pool } = ctx;
    const auth = requireAuth(ctx);

    async function load(userId: string): Promise<RowDataPacket> {
      const [rows] = await pool.query<RowDataPacket[]>(`SELECT ${USER_COLUMNS} FROM usuario WHERE id = ?`, [userId]);
      if (!rows[0]) throw new ApiError(401, 'unauthenticated', 'Sign in again to continue.');
      return rows[0];
    }

    app.get('/users/me', { preHandler: auth }, async (req) => serializeUser(await load(req.userId)));

    app.patch('/users/me', { preHandler: auth }, async (req) => {
      const b = validate(patchBody, req.body);
      const sets: string[] = [];
      const values: unknown[] = [];
      const set = (column: string, value: unknown) => {
        sets.push(`${column} = ?`);
        values.push(value);
      };
      if (b.name !== undefined) set('nome', b.name);
      if (b.course !== undefined) set('curso', b.course);
      if (b.institution !== undefined) set('instituicao', b.institution);
      if (b.timezone !== undefined) set('fuso_horario', b.timezone);
      if (b.theme !== undefined) set('tema', THEME_IN[b.theme]);
      if (b.default_location !== undefined) {
        set('latitude_padrao', b.default_location?.latitude ?? null);
        set('longitude_padrao', b.default_location?.longitude ?? null);
      }
      if (b.notify_exams_and_deadlines !== undefined) set('aviso_provas_entregas', b.notify_exams_and_deadlines ? 1 : 0);
      if (b.notify_field_class_eve !== undefined) set('aviso_vespera_campo', b.notify_field_class_eve ? 1 : 0);
      if (b.notify_report_deadline !== undefined) set('aviso_entrega_relatorio', b.notify_report_deadline ? 1 : 0);
      if (b.remind_record_after_field !== undefined) set('lembrar_registro_pos_campo', b.remind_record_after_field ? 1 : 0);
      if (b.remind_record_time !== undefined) set('hora_lembrete_pos_campo', b.remind_record_time);
      if (b.delete_audio_after_transcription !== undefined)
        set('apagar_audio_apos_transcricao', b.delete_audio_after_transcription ? 1 : 0);
      if (b.first_access_completed) sets.push('primeiro_acesso_concluido_em = COALESCE(primeiro_acesso_concluido_em, NOW(3))');

      if (sets.length) await pool.query(`UPDATE usuario SET ${sets.join(', ')} WHERE id = ?`, [...values, req.userId]);
      return serializeUser(await load(req.userId));
    });

    app.patch('/users/me/password', { preHandler: auth }, async (req, reply) => {
      const b = validate(passwordBody, req.body);
      const user = await load(req.userId);
      if (!(await checkPassword(user.senha_hash as string, b.current_password))) {
        throw new ApiError(422, 'validation', 'Some fields are invalid.', [
          { field: 'current_password', message: 'The current password is wrong.' },
        ]);
      }
      await pool.query('UPDATE usuario SET senha_hash = ? WHERE id = ?', [await hashPassword(b.new_password), req.userId]);
      // other sessions must sign in again with the new password
      await pool.query('UPDATE refresh_token SET revogado_em = NOW(3) WHERE usuario_id = ? AND revogado_em IS NULL', [req.userId]);
      return reply.status(204).send();
    });

    // sign out of every device: no refresh token of the user works any more (access tokens already issued last up to 15 minutes)
    app.delete('/users/me/sessions', { preHandler: auth }, async (req, reply) => {
      await pool.query('UPDATE refresh_token SET revogado_em = NOW(3) WHERE usuario_id = ? AND revogado_em IS NULL', [req.userId]);
      return reply.status(204).send();
    });
  };
