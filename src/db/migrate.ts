import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool, RowDataPacket } from 'mysql2/promise';

const BASE = '0001_init.sql';

/**
 * Splits an SQL script into statements. Understands `DELIMITER` (used by triggers), comments
 * (`-- ...`, `# ...` and blocks) and quoted text, where `;` separates nothing.
 */
export function splitSql(sql: string): string[] {
  const statements: string[] = [];
  let delimiter = ';';
  let current = '';
  let i = 0;
  const endOfLine = () => {
    const f = sql.indexOf('\n', i);
    return f === -1 ? sql.length : f;
  };
  const flush = () => {
    const c = current.trim();
    if (c) statements.push(c);
    current = '';
  };

  while (i < sql.length) {
    const ch = sql[i]!;

    if (current.trim() === '' && /^delimiter\s/i.test(sql.slice(i, i + 10))) {
      const f = endOfLine();
      delimiter = sql.slice(i + 9, f).trim();
      current = '';
      i = f + 1;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-' && /\s/.test(sql[i + 2] ?? ' ')) {
      i = endOfLine();
      continue;
    }
    if (ch === '#') {
      i = endOfLine();
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const f = sql.indexOf('*/', i + 2);
      i = f === -1 ? sql.length : f + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '\\' && ch !== '`') j += 2;
        else if (sql[j] === ch && sql[j + 1] === ch) j += 2;
        else if (sql[j] === ch) break;
        else j += 1;
      }
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (sql.startsWith(delimiter, i)) {
      flush();
      i += delimiter.length;
      continue;
    }
    current += ch;
    i += 1;
  }
  flush();
  return statements;
}

async function tableExists(pool: Pool, name: string): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
    [name],
  );
  return rows.length > 0;
}

/**
 * Applies, in order, the `NNNN_name.sql` files not yet recorded in `migracao`.
 * If the database was already born from 0001 (Docker applies the schema on first start) and the
 * `migracao` table does not exist yet, 0001 is only recorded, not run again.
 * Returns the names of the migrations that actually ran.
 */
export async function applyMigrations(pool: Pool, dir: string, log: (msg: string) => void = () => {}): Promise<string[]> {
  const connection = await pool.getConnection();
  const applied: string[] = [];
  try {
    // only one instance migrating at a time
    // GET_LOCK names are shared by the whole MySQL server, so the name carries the database
    const [lock] = await connection.query<RowDataPacket[]>("SELECT GET_LOCK(CONCAT('caderno_migracao:', DATABASE()), 30) AS ok");
    if (lock[0]?.ok !== 1) throw new Error('Another instance is migrating the database (30 s lock timed out).');

    try {
      const hadControlTable = await tableExists(pool, 'migracao');
      await connection.query(
        'CREATE TABLE IF NOT EXISTS migracao (nome VARCHAR(190) NOT NULL PRIMARY KEY, aplicada_em DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)) ' +
          'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
      );
      if (!hadControlTable && (await tableExists(pool, 'usuario'))) {
        await connection.query('INSERT IGNORE INTO migracao (nome) VALUES (?)', [BASE]);
        log(`${BASE}: database already came from the initial schema; only recorded.`);
      }

      const [done] = await connection.query<RowDataPacket[]>('SELECT nome FROM migracao');
      const alreadyDone = new Set(done.map((r) => r.nome as string));
      const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();

      for (const file of files) {
        if (alreadyDone.has(file)) continue;
        const sql = await readFile(join(dir, file), 'utf8');
        for (const statement of splitSql(sql)) await connection.query(statement);
        await connection.query('INSERT INTO migracao (nome) VALUES (?)', [file]);
        applied.push(file);
        log(`${file}: applied.`);
      }
    } finally {
      await connection.query("SELECT RELEASE_LOCK(CONCAT('caderno_migracao:', DATABASE()))");
    }
  } finally {
    connection.release();
  }
  return applied;
}
