import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { checkPassword } from '../auth/crypto.js';
import type { AppContext } from '../context.js';
import { DEFAULT_INCLUDE, INCLUDE_KEYS, loadReportExport, reportCsv, reportText, reportZip, type IncludeKey } from '../export/report.js';
import { uuid } from '../lib/common.js';
import { findPeriod } from '../periods/periods.js';
import { findReport } from '../reports/reports.js';
import { periodSummary, summaryCsv, summaryText } from '../summary/period.js';
import { deleteAccount, exportAccount } from '../users/account.js';
import { ApiError, validate } from './errors.js';
import { requireAuth } from './require-auth.js';

export const summaryQuery = z.object({ format: z.enum(['json', 'text', 'csv']).default('json') });

const includeList = z
  .string()
  .optional()
  .transform((v) =>
    v === undefined
      ? null
      : v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
  )
  .pipe(z.array(z.enum(INCLUDE_KEYS)).nullable());

export const exportQuery = z.object({
  format: z.enum(['text', 'csv', 'zip']).default('text'),
  include: includeList,
  copy: z.enum(['true', 'false']).default('false'),
});

export const deleteBody = z.object({ password: z.string().min(1, 'Enter your password to delete the account.') });

function download(reply: FastifyReply, body: string | Uint8Array, mime: string, filename: string) {
  return reply
    .header('content-type', mime)
    .header('content-disposition', `attachment; filename="${filename}"`)
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', 'no-store')
    .send(typeof body === 'string' ? body : Buffer.from(body));
}

export const exportRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const { pool, media } = ctx;
    app.addHook('preHandler', requireAuth(ctx));

    async function timezoneOf(userId: string): Promise<string> {
      const [rows] = await pool.query<RowDataPacket[]>('SELECT fuso_horario FROM usuario WHERE id = ?', [userId]);
      return (rows[0]?.fuso_horario as string | undefined) ?? 'America/Araguaina';
    }

    // The "Period summary" screen. Active periods are partial (until today); finished ones go to their end date.
    app.get<{ Params: { id: string } }>('/periods/:id/summary', async (req, reply) => {
      const id = validate(uuid, req.params.id);
      const q = validate(summaryQuery, req.query);
      const period = await findPeriod(pool, req.userId, id);
      const summary = await periodSummary(pool, req.userId, period, await timezoneOf(req.userId));
      const name = summary.period.name
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .replace(/[^A-Za-z0-9]+/g, '-')
        .toLowerCase();
      if (q.format === 'text') return download(reply, summaryText(summary), 'text/plain; charset=utf-8', `resumo-${name}.txt`);
      if (q.format === 'csv') return download(reply, summaryCsv(summary), 'text/csv; charset=utf-8', `resumo-${name}.csv`);
      return summary;
    });

    // The data of a report for the user to build the college document. The app does not build the final report.
    app.get<{ Params: { id: string } }>('/reports/:id/export', async (req, reply) => {
      const id = validate(uuid, req.params.id);
      const q = validate(exportQuery, req.query);
      await findReport(pool, req.userId, id);
      const include = new Set<IncludeKey>(q.include ?? DEFAULT_INCLUDE);
      const data = await loadReportExport(pool, req.userId, id, await timezoneOf(req.userId));
      const text = reportText(data, include);
      if (q.copy === 'true') return { text };
      if (q.format === 'csv') return download(reply, reportCsv(data, include), 'text/csv; charset=utf-8', `relatorio-${data.slug}.csv`);
      if (q.format === 'zip')
        return download(reply, await reportZip(data, include, media), 'application/zip', `relatorio-${data.slug}.zip`);
      return download(reply, text, 'text/plain; charset=utf-8', `relatorio-${data.slug}.txt`);
    });

    // Everything in the account, as JSON (never the password hash or the tokens).
    app.get('/users/me/export', async (req, reply) => {
      const body = JSON.stringify(await exportAccount(pool, req.userId));
      return download(reply, body, 'application/json; charset=utf-8', 'caderno-de-campo-dados.json');
    });

    // Deletes the account, all its data and its files. Asks for the password.
    app.delete('/users/me', async (req, reply) => {
      const b = validate(deleteBody, req.body);
      const [rows] = await pool.query<RowDataPacket[]>('SELECT senha_hash FROM usuario WHERE id = ?', [req.userId]);
      if (!rows[0]) throw new ApiError(401, 'unauthenticated', 'Sign in again to continue.');
      if (!(await checkPassword(rows[0].senha_hash as string, b.password))) {
        throw new ApiError(422, 'validation', 'Some fields are invalid.', [{ field: 'password', message: 'The password is wrong.' }]);
      }
      await deleteAccount(pool, media, req.userId);
      return reply.status(204).send();
    });
  };
