import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import type { Config } from '../config.js';

export interface ConnectionOptions {
  host: string;
  port: number;
  user: string;
  password?: string | undefined;
  database?: string | undefined;
}

// Everything in UTC: `timezone: 'Z'` on the driver and `time_zone` on the session. DATETIME(3) comes
// back as text (dateStrings) so there is no surprise timezone conversion; the API formats dates on output.
export function createPool(o: ConnectionOptions): mysql.Pool {
  const pool = mysql.createPool({
    host: o.host,
    port: o.port,
    user: o.user,
    ...(o.password ? { password: o.password } : {}),
    ...(o.database ? { database: o.database } : {}),
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: true,
    connectionLimit: 10,
    waitForConnections: true,
  });
  pool.on('connection', (connection) => connection.query("SET time_zone = '+00:00'"));
  return pool;
}

export function poolFromConfig(c: Config): mysql.Pool {
  return createPool({ host: c.db.host, port: c.db.port, user: c.db.user, password: c.db.password, database: c.db.name });
}

export function createDb(pool: mysql.Pool) {
  return drizzle(pool);
}

export type Db = ReturnType<typeof createDb>;
