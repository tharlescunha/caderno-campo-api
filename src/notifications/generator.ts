import { randomUUID } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { MarketService } from '../market/service.js';
import { addDays, isoWeekday, localDate, zonedToUtc } from '../lib/time.js';

type Log = { info: (msg: string) => void; error: (msg: string) => void };

/** Reminders are created shortly before they are due (so texts and forecasts are fresh) and also up to 12 h late. */
const LOOK_BACK_MS = 12 * 3600 * 1000;
const LOOK_AHEAD_MS = 3600 * 1000;

const REMINDER_DAYS: Record<string, number> = { no_dia: 0, '1_dia': 1, '3_dias': 3, '1_semana': 7 };
const TYPE_LABEL: Record<string, string> = {
  prova: 'Prova',
  trabalho: 'Trabalho',
  entrega_relatorio: 'Entrega do relatório',
  atividade: 'Atividade',
  evento_faculdade: 'Evento da faculdade',
  outro: 'Evento',
};

interface Candidate {
  type: 'lembrete_evento' | 'lembrete_aula_campo' | 'lembrete_entrega' | 'lembrete_registro_pos_campo';
  title: string;
  text: string;
  referenceType: 'evento' | 'relatorio' | 'materia';
  referenceId: string;
  dueAt: Date;
}

const when = (offsetDays: number, date: string) => {
  const [, m, d] = date.split('-');
  return offsetDays === 0 ? 'hoje' : offsetDays === 1 ? 'amanhã' : `em ${offsetDays} dias (${d}/${m})`;
};

/**
 * Creates the user's reminders (docs/api.md, section 10) and delivers the ones that are due.
 * "Delivered" means it shows in the inbox (`GET /notifications`); push to devices is a later step.
 * No reminder exists for notes.
 */
export class NotificationGenerator {
  constructor(
    private readonly pool: Pool,
    private readonly market: MarketService | undefined,
    private readonly log: Log = { info: () => {}, error: () => {} },
  ) {}

  /** One round: cancel what no longer makes sense, create what is about to be due, deliver what is due. */
  async run(now = new Date()): Promise<{ created: number; delivered: number; cancelled: number }> {
    const cancelled = await this.cancelStale();
    let created = 0;
    const [users] = await this.pool.query<RowDataPacket[]>('SELECT * FROM usuario');
    for (const user of users) {
      try {
        for (const c of await this.candidates(user, now)) if (await this.insert(user.id as string, c)) created++;
      } catch (e) {
        this.log.error(`notifications for a user: ${(e as Error).message}`);
      }
    }
    const { delivered, cancelledAtDelivery } = await this.deliverDue(now);
    if (created || delivered || cancelled || cancelledAtDelivery)
      this.log.info(`notifications: ${created} created, ${delivered} delivered, ${cancelled + cancelledAtDelivery} cancelled.`);
    return { created, delivered, cancelled: cancelled + cancelledAtDelivery };
  }

  // ---- what should exist --------------------------------------------------------------------------------

  private inWindow(due: Date, now: Date) {
    return due.getTime() >= now.getTime() - LOOK_BACK_MS && due.getTime() <= now.getTime() + LOOK_AHEAD_MS;
  }

  private async candidates(user: RowDataPacket, now: Date): Promise<Candidate[]> {
    const tz = user.fuso_horario as string;
    const userId = user.id as string;
    const today = localDate(now, tz);
    const out: Candidate[] = [];

    const [periods] = await this.pool.query<RowDataPacket[]>("SELECT id FROM periodo WHERE usuario_id = ? AND status = 'ativo'", [userId]);
    const activePeriod = periods[0]?.id as string | undefined;

    // 1 and 3. event reminders (08:00 local) and report delivery reminders
    const [events] = await this.pool.query<RowDataPacket[]>(
      `SELECT e.id, e.tipo, e.titulo, e.data, e.lembrete, e.relatorio_id, r.status AS report_status
         FROM evento e LEFT JOIN relatorio r ON r.usuario_id = e.usuario_id AND r.id = e.relatorio_id
        WHERE e.usuario_id = ? AND e.lembrete <> 'nenhum' AND e.concluido = 0 AND e.encerrado_com_periodo = 0 AND e.data >= ? AND e.data <= ?
          AND (e.materia_id IS NULL OR e.materia_id IN (SELECT id FROM materia WHERE usuario_id = e.usuario_id AND periodo_id <=> ?))`,
      [userId, today, addDays(today, 8), activePeriod ?? null],
    );
    for (const e of events) {
      const offset = REMINDER_DAYS[e.lembrete as string]!;
      const date = e.data as string;
      const dueAt = zonedToUtc(addDays(date, -offset), '08:00', tz);
      if (!this.inWindow(dueAt, now)) continue;
      if (e.relatorio_id) {
        if (user.aviso_entrega_relatorio !== 1 || e.report_status !== 'em_andamento') continue;
        out.push({
          type: 'lembrete_entrega',
          title: e.titulo as string,
          text: `Entrega ${when(offset, date)}.`,
          referenceType: 'relatorio',
          referenceId: e.relatorio_id as string,
          dueAt,
        });
      } else {
        if (user.aviso_provas_entregas !== 1) continue;
        out.push({
          type: 'lembrete_evento',
          title: e.titulo as string,
          text: `${TYPE_LABEL[e.tipo as string] ?? 'Evento'} ${when(offset, date)}.`,
          referenceType: 'evento',
          referenceId: e.id as string,
          dueAt,
        });
      }
    }

    if (!activePeriod) return out;

    // field subjects of the active period, with the weekdays of their classes
    const [subjects] = await this.pool.query<RowDataPacket[]>(
      `SELECT m.id, m.nome, m.lembrar_vespera, GROUP_CONCAT(d.dia_semana) AS days
         FROM materia m JOIN materia_dia d ON d.materia_id = m.id
        WHERE m.usuario_id = ? AND m.periodo_id = ? AND m.desativada = 0 AND m.tipo_aula IN ('campo', 'sala_e_campo') GROUP BY m.id`,
      [userId, activePeriod],
    );
    for (const s of subjects) {
      const days = String(s.days).split(',').map(Number);

      // 2. the eve of a field class, 18:00 local, with the forecast and the items left for the next visit
      if (s.lembrar_vespera === 1 && user.aviso_vespera_campo === 1) {
        for (let ahead = 0; ahead <= 2; ahead++) {
          const classDate = addDays(today, ahead);
          if (!days.includes(isoWeekday(classDate))) continue;
          const dueAt = zonedToUtc(addDays(classDate, -1), '18:00', tz);
          if (!this.inWindow(dueAt, now)) continue;
          out.push({
            type: 'lembrete_aula_campo',
            title: `Amanhã: aula de campo de ${s.nome}`,
            text: await this.eveText(userId, s.id as string, classDate, user),
            referenceType: 'materia',
            referenceId: s.id as string,
            dueAt,
          });
        }
      }

      // 4. after a field class day: "Have you recorded what you did?" (only delivered if there is still no entry)
      if (user.lembrar_registro_pos_campo === 1 && days.includes(isoWeekday(today))) {
        const dueAt = zonedToUtc(today, user.hora_lembrete_pos_campo as string, tz);
        if (this.inWindow(dueAt, now)) {
          const [reports] = await this.pool.query<RowDataPacket[]>(
            "SELECT id FROM relatorio WHERE usuario_id = ? AND materia_id = ? AND status = 'em_andamento'",
            [userId, s.id],
          );
          const single = reports.length === 1;
          out.push({
            type: 'lembrete_registro_pos_campo',
            title: `Registro de campo: ${s.nome}`,
            text: `Hoje foi aula de campo de ${s.nome}. Já registrou o que fez?`,
            referenceType: single ? 'relatorio' : 'materia',
            referenceId: (single ? reports[0]!.id : s.id) as string,
            dueAt,
          });
        }
      }
    }
    return out;
  }

  /** "Tomorrow is a field class…" + forecast of that day + open items of the report of the subject. */
  private async eveText(userId: string, subjectId: string, classDate: string, user: RowDataPacket): Promise<string> {
    const parts = ['Amanhã tem aula de campo.'];
    if (this.market) {
      const place =
        user.latitude_padrao == null || user.longitude_padrao == null
          ? this.market.defaultLocation
          : { latitude: Number(user.latitude_padrao), longitude: Number(user.longitude_padrao) };
      const day = (await this.market.weather(place.latitude, place.longitude)).value?.forecast_days.find((d) => d.date === classDate);
      if (day) parts.push(`Previsão: ${Math.round(day.min)}° a ${Math.round(day.max)}°, chance de chuva ${day.rain_chance_pct}%.`);
    }
    const [todos] = await this.pool.query<RowDataPacket[]>(
      `SELECT p.texto FROM registro_pendencia p JOIN registro g ON g.usuario_id = p.usuario_id AND g.id = p.registro_id
         JOIN relatorio r ON r.usuario_id = g.usuario_id AND r.id = g.relatorio_id
        WHERE p.usuario_id = ? AND r.materia_id = ? AND r.status = 'em_andamento' AND p.feito = 0 ORDER BY g.data_hora, p.ordem LIMIT 5`,
      [userId, subjectId],
    );
    if (todos.length) parts.push(`Itens da última visita: ${todos.map((t) => t.texto).join('; ')}.`);
    return parts.join(' ').slice(0, 500);
  }

  private async insert(userId: string, c: Candidate): Promise<boolean> {
    const [exists] = await this.pool.query<RowDataPacket[]>(
      'SELECT 1 FROM notificacao WHERE usuario_id = ? AND tipo = ? AND referencia_id = ? AND agendada_para = ?',
      [userId, c.type, c.referenceId, c.dueAt],
    );
    if (exists[0]) return false;
    await this.pool.query(
      'INSERT INTO notificacao (id, usuario_id, tipo, titulo, texto, referencia_tipo, referencia_id, agendada_para) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [randomUUID(), userId, c.type, c.title.slice(0, 160), c.text, c.referenceType, c.referenceId, c.dueAt],
    );
    return true;
  }

  // ---- what should no longer happen ---------------------------------------------------------------------

  /** Cancels reminders not yet delivered whose source changed (event done or deleted, report finished, subject dropped…). */
  private async cancelStale(): Promise<number> {
    const unsent = 'enviada_em IS NULL AND cancelada_em IS NULL';
    const queries = [
      `UPDATE notificacao n SET cancelada_em = NOW(3) WHERE ${unsent} AND tipo = 'lembrete_evento'
         AND NOT EXISTS (SELECT 1 FROM evento e WHERE e.usuario_id = n.usuario_id AND e.id = n.referencia_id AND e.concluido = 0 AND e.encerrado_com_periodo = 0 AND e.lembrete <> 'nenhum')`,
      `UPDATE notificacao n SET cancelada_em = NOW(3) WHERE ${unsent} AND tipo = 'lembrete_entrega'
         AND NOT EXISTS (SELECT 1 FROM relatorio r JOIN evento e ON e.usuario_id = r.usuario_id AND e.relatorio_id = r.id
                          WHERE r.usuario_id = n.usuario_id AND r.id = n.referencia_id AND r.status = 'em_andamento' AND e.concluido = 0 AND e.encerrado_com_periodo = 0)`,
      `UPDATE notificacao n SET cancelada_em = NOW(3) WHERE ${unsent} AND tipo IN ('lembrete_aula_campo', 'lembrete_registro_pos_campo') AND referencia_tipo = 'materia'
         AND NOT EXISTS (SELECT 1 FROM materia m JOIN periodo p ON p.usuario_id = m.usuario_id AND p.id = m.periodo_id
                          WHERE m.usuario_id = n.usuario_id AND m.id = n.referencia_id AND m.desativada = 0 AND p.status = 'ativo')`,
      `UPDATE notificacao n SET cancelada_em = NOW(3) WHERE ${unsent} AND tipo = 'lembrete_registro_pos_campo' AND referencia_tipo = 'relatorio'
         AND NOT EXISTS (SELECT 1 FROM relatorio r WHERE r.usuario_id = n.usuario_id AND r.id = n.referencia_id AND r.status = 'em_andamento')`,
    ];
    let total = 0;
    for (const sql of queries) {
      const [result] = await this.pool.query<{ affectedRows: number } & RowDataPacket[]>(sql);
      total += result.affectedRows;
    }
    return total;
  }

  // ---- delivery -----------------------------------------------------------------------------------------

  private async deliverDue(now: Date): Promise<{ delivered: number; cancelledAtDelivery: number }> {
    let cancelledAtDelivery = 0;
    // "Already recorded?" is checked at the moment of delivery, not when the reminder was created
    const [afterField] = await this.pool.query<RowDataPacket[]>(
      "SELECT n.id, n.usuario_id, n.referencia_tipo, n.referencia_id, n.agendada_para, u.fuso_horario FROM notificacao n JOIN usuario u ON u.id = n.usuario_id WHERE n.tipo = 'lembrete_registro_pos_campo' AND n.enviada_em IS NULL AND n.cancelada_em IS NULL AND n.agendada_para <= ?",
      [now],
    );
    for (const n of afterField) {
      const tz = n.fuso_horario as string;
      const day = localDate(new Date(`${(n.agendada_para as string).replace(' ', 'T')}Z`), tz);
      const from = zonedToUtc(day, '00:00', tz);
      const to = zonedToUtc(addDays(day, 1), '00:00', tz);
      const bySubject = n.referencia_tipo === 'materia';
      const [found] = await this.pool.query<RowDataPacket[]>(
        `SELECT 1 FROM registro g JOIN relatorio r ON r.usuario_id = g.usuario_id AND r.id = g.relatorio_id
          WHERE g.usuario_id = ? AND ${bySubject ? 'r.materia_id' : 'r.id'} = ? AND g.data_hora >= ? AND g.data_hora < ? LIMIT 1`,
        [n.usuario_id, n.referencia_id, from, to],
      );
      if (found[0]) {
        await this.pool.query('UPDATE notificacao SET cancelada_em = NOW(3) WHERE id = ?', [n.id]);
        cancelledAtDelivery++;
      }
    }
    const [result] = await this.pool.query<{ affectedRows: number } & RowDataPacket[]>(
      'UPDATE notificacao SET enviada_em = NOW(3) WHERE enviada_em IS NULL AND cancelada_em IS NULL AND agendada_para <= ?',
      [now],
    );
    return { delivered: result.affectedRows, cancelledAtDelivery };
  }
}
