import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { checkPassword, hashPassword, sha256 } from '../auth/crypto.js';
import { issueTokens } from '../auth/sessions.js';
import type { AppContext } from '../context.js';
import { serializeUser, USER_COLUMNS } from '../users/user.js';
import { ApiError, validate } from './errors.js';

export const registerBody = z.object({
  name: z.string().trim().min(1, 'Enter your name.').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid e-mail.').max(190),
  password: z.string().min(8, 'The password needs at least 8 characters.').max(200),
  course: z.string().trim().max(120).optional(),
  institution: z.string().trim().max(120).optional(),
  accepted_terms: z.literal(true, { error: 'You need to accept the terms.' }),
});

export const loginBody = z.object({
  email: z.string().trim().toLowerCase().min(1, 'Enter your e-mail.'),
  password: z.string().min(1, 'Enter your password.'),
  keep_logged_in: z.boolean().default(false),
});

export const refreshBody = z.object({ refresh_token: z.string().min(1, 'Send the refresh token.') });

const BAD_CREDENTIALS = new ApiError(401, 'invalid_credentials', 'Wrong e-mail or password.');

export const authRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const { pool, config, loginLimiter } = ctx;

    app.post('/auth/register', async (req, reply) => {
      const body = validate(registerBody, req.body);

      const [count] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM usuario');
      if ((count[0]?.n as number) > 0 && !config.allowSignup) {
        throw new ApiError(403, 'signup_closed', 'Sign-up is closed on this server.');
      }

      const id = randomUUID();
      try {
        await pool.query(
          'INSERT INTO usuario (id, nome, email, senha_hash, curso, instituicao, aceitou_termos_em) VALUES (?, ?, ?, ?, ?, ?, NOW(3))',
          [id, body.name, body.email, await hashPassword(body.password), body.course ?? null, body.institution ?? null],
        );
      } catch (e) {
        if ((e as { code?: string }).code === 'ER_DUP_ENTRY') throw new ApiError(409, 'email_in_use', 'This e-mail is already registered.');
        throw e;
      }

      const [rows] = await pool.query<RowDataPacket[]>(`SELECT ${USER_COLUMNS} FROM usuario WHERE id = ?`, [id]);
      const { tokens } = await issueTokens(pool, config.jwtSecret, id, false, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      return reply.status(201).send({ user: serializeUser(rows[0]!), ...tokens });
    });

    app.post('/auth/login', async (req) => {
      const body = validate(loginBody, req.body);
      const keys = [`ip:${req.ip}`, `email:${body.email}`];
      if (keys.some((k) => loginLimiter.isBlocked(k)))
        throw new ApiError(429, 'too_many_attempts', 'Too many attempts. Wait a few minutes.');

      const [rows] = await pool.query<RowDataPacket[]>(`SELECT ${USER_COLUMNS} FROM usuario WHERE email = ?`, [body.email]);
      const row = rows[0];
      // same answer for unknown e-mail and wrong password
      if (!row || !(await checkPassword(row.senha_hash as string, body.password))) {
        keys.forEach((k) => loginLimiter.fail(k));
        throw BAD_CREDENTIALS;
      }
      loginLimiter.reset(`email:${body.email}`);

      await pool.query('UPDATE usuario SET ultimo_login_em = NOW(3) WHERE id = ?', [row.id]);
      const { tokens } = await issueTokens(pool, config.jwtSecret, row.id as string, body.keep_logged_in, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      return { user: serializeUser(row), ...tokens };
    });

    // Rotating refresh token: the old one stops working as soon as the new pair is issued.
    app.post('/auth/refresh', async (req) => {
      const { refresh_token } = validate(refreshBody, req.body);
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [rows] = await connection.query<RowDataPacket[]>(
          'SELECT id, usuario_id, criado_em, expira_em, revogado_em FROM refresh_token WHERE token_hash = ? FOR UPDATE',
          [sha256(refresh_token)],
        );
        const old = rows[0];
        const expired = old && new Date(`${(old.expira_em as string).replace(' ', 'T')}Z`).getTime() <= Date.now();
        if (!old || old.revogado_em || expired) {
          await connection.rollback();
          throw new ApiError(401, 'unauthenticated', 'Sign in again to continue.');
        }
        const lifetimeMs =
          new Date(`${(old.expira_em as string).replace(' ', 'T')}Z`).getTime() -
          new Date(`${(old.criado_em as string).replace(' ', 'T')}Z`).getTime();
        const keepLoggedIn = lifetimeMs > 2 * 24 * 60 * 60 * 1000;

        const { tokens, refreshId } = await issueTokens(connection, config.jwtSecret, old.usuario_id as string, keepLoggedIn, {
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
        await connection.query('UPDATE refresh_token SET revogado_em = NOW(3), substituido_por = ? WHERE id = ?', [refreshId, old.id]);
        await connection.commit();
        return tokens;
      } catch (e) {
        await connection.rollback().catch(() => {});
        throw e;
      } finally {
        connection.release();
      }
    });

    app.post('/auth/logout', async (req, reply) => {
      const { refresh_token } = validate(refreshBody, req.body);
      await pool.query('UPDATE refresh_token SET revogado_em = NOW(3) WHERE token_hash = ? AND revogado_em IS NULL', [
        sha256(refresh_token),
      ]);
      return reply.status(204).send();
    });
  };
