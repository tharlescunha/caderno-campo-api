import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { pageOf, pageQuery, uuid, type Db } from '../lib/common.js';
import { isoDate } from '../users/user.js';
import { ApiError, validate } from './errors.js';
import { indexSubject } from '../search/index.js';
import { requireAuth } from './require-auth.js';

export const createBody = z.object({
  id: uuid.optional(),
  name: z.string().trim().min(1, 'Enter the name.').max(120),
  email: z.string().trim().email('Enter a valid e-mail.').max(190).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
});

export const patchBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email('Enter a valid e-mail.').max(190).nullable(),
    notes: z.string().trim().max(5000).nullable(),
  })
  .partial()
  .strict();

async function fetchTeachers(db: Db, userId: string, where: string, params: unknown[], paging?: { limit: number; offset: number }) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, nome, email, observacoes, criado_em, atualizado_em, versao FROM professor
      WHERE usuario_id = ? ${where} ORDER BY nome${paging ? ' LIMIT ? OFFSET ?' : ''}`,
    [userId, ...params, ...(paging ? [paging.limit, paging.offset] : [])],
  );
  const subjects = new Map<string, { id: string; name: string }[]>();
  if (rows.length) {
    const [subjectRows] = await db.query<RowDataPacket[]>(
      'SELECT id, nome, professor_id FROM materia WHERE usuario_id = ? AND professor_id IN (?) ORDER BY nome',
      [userId, rows.map((r) => r.id)],
    );
    for (const s of subjectRows) {
      const list = subjects.get(s.professor_id as string) ?? [];
      list.push({ id: s.id as string, name: s.nome as string });
      subjects.set(s.professor_id as string, list);
    }
  }
  return rows.map((r) => ({
    id: r.id as string,
    name: r.nome as string,
    email: (r.email as string | null) ?? null,
    notes: (r.observacoes as string | null) ?? null,
    subjects: subjects.get(r.id as string) ?? [],
    created_at: isoDate(r.criado_em as string),
    updated_at: isoDate(r.atualizado_em as string),
    version: r.versao as number,
  }));
}

export const teacherRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const { pool } = ctx;
    app.addHook('preHandler', requireAuth(ctx));

    app.get('/teachers', async (req) => {
      const { page, limit } = validate(pageQuery, req.query);
      const [count] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM professor WHERE usuario_id = ?', [req.userId]);
      const items = await fetchTeachers(pool, req.userId, '', [], { limit, offset: (page - 1) * limit });
      return pageOf(items, page, limit, Number(count[0]?.n ?? 0));
    });

    app.post('/teachers', async (req, reply) => {
      const b = validate(createBody, req.body);
      const id = b.id ?? randomUUID();
      await pool.query('INSERT INTO professor (id, usuario_id, nome, email, observacoes) VALUES (?, ?, ?, ?, ?)', [
        id,
        req.userId,
        b.name,
        b.email ?? null,
        b.notes ?? null,
      ]);
      const [item] = await fetchTeachers(pool, req.userId, 'AND id = ?', [id]);
      return reply.status(201).send(item);
    });

    app.get<{ Params: { id: string } }>('/teachers/:id', async (req) => {
      const [item] = await fetchTeachers(pool, req.userId, 'AND id = ?', [validate(uuid, req.params.id)]);
      if (!item) throw new ApiError(404, 'not_found', 'Teacher not found.');
      return item;
    });

    app.patch<{ Params: { id: string } }>('/teachers/:id', async (req) => {
      const id = validate(uuid, req.params.id);
      const b = validate(patchBody, req.body);
      const [exists] = await fetchTeachers(pool, req.userId, 'AND id = ?', [id]);
      if (!exists) throw new ApiError(404, 'not_found', 'Teacher not found.');

      const sets: string[] = [];
      const values: unknown[] = [];
      if (b.name !== undefined) {
        sets.push('nome = ?');
        values.push(b.name);
      }
      if (b.email !== undefined) {
        sets.push('email = ?');
        values.push(b.email);
      }
      if (b.notes !== undefined) {
        sets.push('observacoes = ?');
        values.push(b.notes);
      }
      if (sets.length)
        await pool.query(`UPDATE professor SET ${sets.join(', ')} WHERE usuario_id = ? AND id = ?`, [...values, req.userId, id]);
      if (b.name !== undefined) {
        // the teacher's name is searchable through the subjects that have this teacher
        const [subjects] = await pool.query<RowDataPacket[]>('SELECT id FROM materia WHERE usuario_id = ? AND professor_id = ?', [
          req.userId,
          id,
        ]);
        for (const s of subjects) await indexSubject(pool, req.userId, s.id as string);
      }
      const [item] = await fetchTeachers(pool, req.userId, 'AND id = ?', [id]);
      return item;
    });

    app.delete<{ Params: { id: string } }>('/teachers/:id', async (req, reply) => {
      const id = validate(uuid, req.params.id);
      const [teacher] = await fetchTeachers(pool, req.userId, 'AND id = ?', [id]);
      if (!teacher) throw new ApiError(404, 'not_found', 'Teacher not found.');
      if (teacher.subjects.length > 0) {
        throw new ApiError(409, 'teacher_in_use', 'This teacher is in subjects. Change the teacher there first.', undefined, {
          subjects: teacher.subjects,
        });
      }
      await pool.query('DELETE FROM professor WHERE usuario_id = ? AND id = ?', [req.userId, id]);
      return reply.status(204).send();
    });
  };
