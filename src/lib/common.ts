import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';

export type Db = Pool | PoolConnection;

export const uuid = z.uuid();

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function pageOf<T>(items: T[], page: number, limit: number, total: number) {
  return { items, page, limit, total };
}

/** Two-way map between the English API value and the Portuguese database value. */
export function enumMap<const T extends Record<string, string>>(apiToDb: T) {
  const dbToApi = Object.fromEntries(Object.entries(apiToDb).map(([a, d]) => [d, a])) as Record<string, string>;
  return {
    apiValues: Object.keys(apiToDb) as [keyof T & string, ...(keyof T & string)[]],
    toDb: (api: keyof T & string): string => apiToDb[api] as string,
    toApi: (db: string): string => dbToApi[db] ?? db,
  };
}

export const classType = enumMap({ classroom: 'sala', field: 'campo', classroom_and_field: 'sala_e_campo' });
export const subjectColor = enumMap({ blue: 'azul', green: 'verde', earth: 'terra', purple: 'roxo', red: 'vermelho' });
export const eventType = enumMap({
  exam: 'prova',
  assignment: 'trabalho',
  report_delivery: 'entrega_relatorio',
  activity: 'atividade',
  college_event: 'evento_faculdade',
  other: 'outro',
});

export const reminder = enumMap({ none: 'nenhum', on_the_day: 'no_dia', '1_day': '1_dia', '3_days': '3_dias', '1_week': '1_semana' });

export const deliveryFormat = enumMap({ pdf: 'pdf', printed: 'impresso', slides: 'slides', other: 'outro' });
export const reportType = enumMap({ continuous: 'continuo', one_off: 'pontual' });
export const reportStatus = enumMap({ in_progress: 'em_andamento', finished: 'finalizado' });
export const finishedBy = enumMap({ user: 'usuario', period: 'periodo' });
export const entryStatus = enumMap({ draft: 'rascunho', completed: 'concluido' });
export const activity = enumMap({
  fertilization: 'adubacao',
  cleaning: 'limpeza',
  inspection: 'vistoria',
  application: 'aplicacao',
  irrigation: 'irrigacao',
  planting: 'plantio',
  harvest: 'colheita',
  other: 'outro',
});
export const irrigation = enumMap({ working: 'funcionando', faulty: 'com_falha', none: 'sem_irrigacao', to_install: 'a_instalar' });
export const cropCondition = enumMap({ excellent: 'otima', good: 'boa', fair: 'regular', poor: 'ruim' });
export const pestLevel = enumMap({ low: 'baixo', medium: 'medio', high: 'alto' });
export const weatherOrigin = enumMap({ gps: 'gps', manual: 'manual', pending: 'pendente', gps_late: 'gps_atrasado' });

/** Today's date (YYYY-MM-DD) in the user's timezone. */
export async function todayFor(db: Db, userId: string): Promise<string> {
  const [rows] = await db.query<RowDataPacket[]>('SELECT fuso_horario FROM usuario WHERE id = ?', [userId]);
  const timezone = (rows[0]?.fuso_horario as string | undefined) ?? 'America/Araguaina';
  return new Date().toLocaleDateString('en-CA', { timeZone: timezone });
}

export const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

/** Runs `fn` in a transaction (commit on success, rollback on any error). */
export async function inTransaction<T>(pool: Pool, fn: (connection: PoolConnection) => Promise<T>): Promise<T> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (e) {
    await connection.rollback().catch(() => {});
    throw e;
  } finally {
    connection.release();
  }
}
