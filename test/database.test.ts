import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/connection.js';
import { applyMigrations, splitSql } from '../src/db/migrate.js';
import { createTestDatabase, MIGRATIONS_DIR, testConnection, type TestDatabase } from './helpers.js';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase(false);
});
afterAll(() => t?.drop());

async function user(): Promise<string> {
  const id = randomUUID();
  await t.pool.query('INSERT INTO usuario (id, nome, email, senha_hash, aceitou_termos_em) VALUES (?, ?, ?, ?, NOW(3))', [
    id,
    'Test',
    `${id}@example.test`,
    'x',
  ]);
  return id;
}

describe('migrations on MySQL 8.4', () => {
  it('applies 0001 on an empty database and records it in `migracao`', async () => {
    expect(await applyMigrations(t.pool, MIGRATIONS_DIR)).toEqual(['0001_init.sql', '0002_sync_log.sql', '0003_capa_relatorio.sql', '0004_formato_entrega.sql']);
    const [tables] = await t.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' AND table_name <> 'migracao'",
    );
    expect(tables[0]?.n).toBe(26); // 25 of the schema + historico_texto
    const [triggers] = await t.pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM information_schema.triggers WHERE trigger_schema = DATABASE()',
    );
    expect(triggers[0]?.n).toBe(53); // 11 of the schema + 42 of the sync log
  });

  it('running again does nothing', async () => {
    expect(await applyMigrations(t.pool, MIGRATIONS_DIR)).toEqual([]);
  });

  it('0002 can run again after a partial run (MySQL cannot roll back DDL)', async () => {
    const again = splitSql(readFileSync(`${MIGRATIONS_DIR}/0002_sync_log.sql`, 'utf8')).filter((s) => !s.startsWith('INSERT INTO mudanca'));
    for (const s of again) await t.pool.query(s);
    const [triggers] = await t.pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM information_schema.triggers WHERE trigger_schema = DATABASE()',
    );
    expect(triggers[0]?.n).toBe(53);
  });

  it('a database that came from the schema (Docker) only records 0001', async () => {
    const other = await createTestDatabase(false);
    try {
      for (const s of splitSql(readFileSync(`${MIGRATIONS_DIR}/0001_init.sql`, 'utf8'))) await other.pool.query(s);
      expect(await applyMigrations(other.pool, MIGRATIONS_DIR)).toEqual(['0002_sync_log.sql', '0003_capa_relatorio.sql', '0004_formato_entrega.sql']); // 0001 is only recorded
      const [m] = await other.pool.query<RowDataPacket[]>('SELECT nome FROM migracao');
      expect(m.map((r) => r.nome).sort()).toEqual(['0001_init.sql', '0002_sync_log.sql', '0003_capa_relatorio.sql', '0004_formato_entrega.sql']);
    } finally {
      await other.drop();
    }
  });
  it('rows that existed before 0002 enter the sync log, parents first', async () => {
    const old = await createTestDatabase(false);
    try {
      for (const s of splitSql(readFileSync(`${MIGRATIONS_DIR}/0001_init.sql`, 'utf8'))) await old.pool.query(s);
      const userId = randomUUID();
      const periodId = randomUUID();
      await old.pool.query('INSERT INTO usuario (id, nome, email, senha_hash, aceitou_termos_em) VALUES (?, ?, ?, ?, NOW(3))', [
        userId,
        'Old',
        'old@example.test',
        'x',
      ]);
      await old.pool.query("INSERT INTO periodo (id, usuario_id, nome, data_inicio) VALUES (?, ?, 'Old term', '2026-08-03')", [
        periodId,
        userId,
      ]);
      await applyMigrations(old.pool, MIGRATIONS_DIR);
      const [log] = await old.pool.query<RowDataPacket[]>(
        'SELECT entidade, entidade_id, operacao FROM mudanca WHERE usuario_id = ? ORDER BY seq',
        [userId],
      );
      expect(log.map((r) => `${r.entidade}:${r.operacao}`)).toEqual(['user:upsert', 'period:upsert']);
      expect(log[1]?.entidade_id).toBe(periodId);
    } finally {
      await old.drop();
    }
  });
});

describe('schema rules', () => {
  it('trigger bumps `versao` on every UPDATE', async () => {
    const id = await user();
    await t.pool.query('UPDATE usuario SET nome = ? WHERE id = ?', ['New name', id]);
    const [r] = await t.pool.query<RowDataPacket[]>('SELECT versao FROM usuario WHERE id = ?', [id]);
    expect(r[0]?.versao).toBe(2);
  });

  it('only one active period per user', async () => {
    const u = await user();
    const insert = () =>
      t.pool.query("INSERT INTO periodo (id, usuario_id, nome, data_inicio) VALUES (?, ?, 'Fifth term', '2026-08-01')", [randomUUID(), u]);
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
  });

  it('a pest marked without a name is refused (CHECK)', async () => {
    const u = await user();
    const [p, m, rel] = [randomUUID(), randomUUID(), randomUUID()];
    await t.pool.query("INSERT INTO periodo (id, usuario_id, nome, data_inicio) VALUES (?, ?, 'P', '2026-08-01')", [p, u]);
    await t.pool.query("INSERT INTO materia (id, usuario_id, periodo_id, nome) VALUES (?, ?, ?, 'M')", [m, u, p]);
    await t.pool.query("INSERT INTO relatorio (id, usuario_id, materia_id, titulo, tipo) VALUES (?, ?, ?, 'R', 'continuo')", [rel, u, m]);
    await expect(
      t.pool.query(
        "INSERT INTO registro (id, usuario_id, relatorio_id, data_hora, atividades, houve_praga) VALUES (?, ?, ?, NOW(3), '[]', 1)",
        [randomUUID(), u, rel],
      ),
    ).rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
  });

  it('session is in UTC', async () => {
    const pool = createPool({ ...testConnection, database: t.name });
    try {
      const [r] = await pool.query<RowDataPacket[]>('SELECT @@session.time_zone AS tz');
      expect(r[0]?.tz).toBe('+00:00');
    } finally {
      await pool.end();
    }
  });
});
