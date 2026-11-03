import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { splitSql } from '../src/db/migrate.js';

describe('splitSql', () => {
  it('ignora comentários e não separa em ; dentro de texto ou comentário', () => {
    const sql = '-- um; dois\nSET NAMES utf8mb4; /* a; b */\nINSERT INTO t VALUES (\'a;b\', "c;d");\n# fim; de linha\n';
    expect(splitSql(sql)).toEqual(['SET NAMES utf8mb4', 'INSERT INTO t VALUES (\'a;b\', "c;d")']);
  });

  it('respeita DELIMITER (triggers)', () => {
    const sql =
      'DELIMITER $$\nCREATE TRIGGER x BEFORE UPDATE ON t FOR EACH ROW BEGIN\n  SET NEW.a = 1; SET NEW.b = 2; END$$\nDELIMITER ;\nSELECT 1;';
    const r = splitSql(sql);
    expect(r).toHaveLength(2);
    expect(r[0]).toContain('SET NEW.a = 1; SET NEW.b = 2; END');
    expect(r[1]).toBe('SELECT 1');
  });

  it('a migração 0001 vira 2 SET + 25 CREATE TABLE + 11 triggers', () => {
    const r = splitSql(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
    expect(r.filter((c) => c.startsWith('SET'))).toHaveLength(2);
    expect(r.filter((c) => c.startsWith('CREATE TABLE'))).toHaveLength(25);
    expect(r.filter((c) => c.startsWith('CREATE TRIGGER'))).toHaveLength(11);
  });
});
