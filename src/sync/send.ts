import { randomUUID } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { uuid } from '../lib/common.js';
import { InternalClient, itemPath, SYNC_ENTITIES, writePath, type Json, type SyncEntity } from './internal.js';

export const MAX_OPERATIONS = 50;

export const operationSchema = z.object({
  operation_id: uuid,
  entity: z.enum(SYNC_ENTITIES as [SyncEntity, ...SyncEntity[]]),
  operation: z.enum(['create', 'update', 'delete', 'close_period']),
  id: uuid,
  data: z.record(z.string(), z.unknown()).optional(),
  /** version of the item the phone knew when it made the change */
  base_version: z.number().int().min(1).optional(),
  /** the values the changed fields had in that version: lets the server tell "only I changed it" from a real conflict */
  base_data: z.record(z.string(), z.unknown()).optional(),
  /** when the user made the change (phone clock) */
  done_at: z.iso.datetime({ offset: true }).optional(),
});

export const sendSchema = z.object({
  device_id: uuid.optional(),
  operations: z.array(operationSchema).min(1).max(MAX_OPERATIONS),
});

export type Operation = z.infer<typeof operationSchema>;

export interface OperationResult {
  operation_id: string;
  status: 'ok' | 'already_processed' | 'conflict' | 'error';
  version?: number;
  server_version?: number;
  item?: unknown;
  applied_fields?: string[];
  ignored_fields?: string[];
  code?: string;
  message?: string;
  fields?: unknown;
}

// Which operations each entity accepts through the batch route. Photos, audios and attachments are created by /sync/media;
// to-do items are created inside their entry (`next_visit`).
const CREATE: Partial<Record<SyncEntity, (data: Record<string, unknown>) => { url: string; payload: Record<string, unknown> }>> = {
  period: (d) => ({ url: '/periods', payload: d }),
  teacher: (d) => ({ url: '/teachers', payload: d }),
  subject: (d) => ({ url: '/subjects', payload: d }),
  report: (d) => ({ url: '/reports', payload: d }),
  event: (d) => ({ url: '/events', payload: d }),
  note: (d) => ({ url: '/notes', payload: d }),
  entry: (d) => {
    const { report_id, ...rest } = d;
    return { url: `/reports/${String(report_id)}/entries`, payload: rest };
  },
};
const UPDATE: SyncEntity[] = ['user', 'period', 'teacher', 'subject', 'report', 'entry', 'todo', 'event', 'note', 'photo', 'audio'];
const DELETE: SyncEntity[] = ['period', 'teacher', 'subject', 'report', 'entry', 'todo', 'event', 'note', 'photo', 'audio'];

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const TEXT_FIELD: Partial<Record<SyncEntity, string>> = { note: 'text', entry: 'notes' };

/** The value an item has now for a field of the PATCH body, or `undefined` when it cannot be compared. */
function currentValue(entity: SyncEntity, item: Json, key: string): unknown {
  if (key === 'subject_id') return entity === 'event' ? item.subject_id : (item.subject?.id ?? null);
  if (key === 'teacher_id') return item.teacher?.id ?? null;
  return key in item ? item[key] : undefined;
}

function errorResult(operationId: string, status: number, body: Json): OperationResult {
  const e = body?.error;
  return {
    operation_id: operationId,
    status: 'error',
    code: e?.code ?? (status >= 500 ? 'internal_error' : 'error'),
    message: e?.message ?? 'The operation failed.',
    ...(e?.fields ? { fields: e.fields } : {}),
  };
}

const idsIn = (value: unknown, out = new Set<string>()): Set<string> => {
  if (typeof value === 'string') {
    if (uuid.safeParse(value).success) out.add(value);
  } else if (Array.isArray(value)) value.forEach((v) => idsIn(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => idsIn(v, out));
  return out;
};

export class SyncSender {
  constructor(
    private readonly pool: Pool,
    private readonly client: InternalClient,
    private readonly userId: string,
  ) {}

  /**
   * Applies the batch in order and keeps going when one fails. An operation already seen (same `operation_id`)
   * is not run again: its first answer comes back as `already_processed`.
   */
  async run(deviceId: string | undefined, operations: Operation[]): Promise<OperationResult[]> {
    const results: OperationResult[] = [];
    const failed = new Set<string>();
    for (const op of operations) {
      const seen = await this.seen(op.operation_id);
      if (seen) {
        results.push({ ...seen, status: 'already_processed' });
        continue;
      }
      const touched = idsIn(op.data);
      touched.add(op.id);
      const broken = [...touched].find((id) => failed.has(id));
      let result: OperationResult;
      if (broken) {
        // not stored: after the fix, the phone sends it again
        results.push({
          operation_id: op.operation_id,
          status: 'error',
          code: 'dependency',
          message: 'A previous operation this one depends on failed.',
        });
        failed.add(op.id);
        continue;
      }
      try {
        result = await this.apply(op);
      } catch (e) {
        result = { operation_id: op.operation_id, status: 'error', code: 'internal_error', message: (e as Error).message.slice(0, 200) };
      }
      if (result.status === 'error') failed.add(op.id);
      // internal errors are not remembered: the same operation can be tried again
      if (result.code !== 'internal_error') await this.remember(op.operation_id, deviceId, result);
      results.push(result);
    }
    return results;
  }

  private async seen(operationId: string): Promise<OperationResult | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT resultado FROM operacao_sync WHERE usuario_id = ? AND id_operacao = ?', [
      this.userId,
      operationId,
    ]);
    const raw = rows[0]?.resultado;
    return raw ? ((typeof raw === 'string' ? JSON.parse(raw) : raw) as OperationResult) : null;
  }

  private async remember(operationId: string, deviceId: string | undefined, result: OperationResult): Promise<void> {
    await this.pool.query('INSERT IGNORE INTO operacao_sync (usuario_id, id_operacao, dispositivo_id, resultado) VALUES (?, ?, ?, ?)', [
      this.userId,
      operationId,
      deviceId ?? null,
      JSON.stringify(result),
    ]);
  }

  private async apply(op: Operation): Promise<OperationResult> {
    switch (op.operation) {
      case 'create':
        return this.create(op);
      case 'update':
        return this.update(op);
      case 'delete':
        return this.remove(op);
      case 'close_period':
        return this.closePeriod(op);
    }
  }

  private unsupported(op: Operation): OperationResult {
    return {
      operation_id: op.operation_id,
      status: 'error',
      code: 'unsupported',
      message: `"${op.operation}" is not available for ${op.entity} in a batch.`,
    };
  }

  // ---- create: if the id exists, it is a repeat ----------------------------------------------------------

  private async create(op: Operation): Promise<OperationResult> {
    const build = CREATE[op.entity];
    if (!build) return this.unsupported(op);
    const existing = await this.client.call('GET', itemPath(op.entity, op.id));
    if (existing.status === 200) return { operation_id: op.operation_id, status: 'ok', version: existing.body.version };
    const { url, payload } = build({ ...(op.data ?? {}) });
    const response = await this.client.call('POST', url, { ...payload, id: op.id });
    if (response.status >= 200 && response.status < 300)
      return { operation_id: op.operation_id, status: 'ok', version: response.body?.version };
    return errorResult(op.operation_id, response.status, response.body);
  }

  // ---- delete: already gone is fine ------------------------------------------------------------------------

  private async remove(op: Operation): Promise<OperationResult> {
    if (!DELETE.includes(op.entity)) return this.unsupported(op);
    const response = await this.client.call('DELETE', writePath(op.entity, op.id));
    if (response.status === 404 || (response.status >= 200 && response.status < 300))
      return { operation_id: op.operation_id, status: 'ok' };
    return errorResult(op.operation_id, response.status, response.body);
  }

  private async closePeriod(op: Operation): Promise<OperationResult> {
    if (op.entity !== 'period') return this.unsupported(op);
    const response = await this.client.call('POST', `/periods/${op.id}/close`);
    // already closed (by the site, or by a repeat): the phone just receives the result in the changes
    if (response.status === 409 && response.body?.error?.code === 'period_finished') return { operation_id: op.operation_id, status: 'ok' };
    if (response.status >= 200 && response.status < 300)
      return { operation_id: op.operation_id, status: 'ok', version: response.body?.version };
    return errorResult(op.operation_id, response.status, response.body);
  }

  // ---- update: three-way merge by field -------------------------------------------------------------------

  private async update(op: Operation): Promise<OperationResult> {
    if (!UPDATE.includes(op.entity)) return this.unsupported(op);
    const current = await this.client.call('GET', itemPath(op.entity, op.id));
    if (current.status === 404)
      return { operation_id: op.operation_id, status: 'error', code: 'not_found', message: 'The item does not exist on the server.' };
    if (current.status !== 200) return errorResult(op.operation_id, current.status, current.body);

    const item = current.body as Json;
    const data = { ...(op.data ?? {}) };
    const applied: string[] = [];
    const ignored: string[] = [];
    let conflict = false;

    const serverMoved = op.base_version !== undefined && op.base_version < item.version;
    if (serverMoved) {
      const serverTime = Date.parse(item.updated_at ?? item.created_at ?? '') || 0;
      const clientWins = (op.done_at ? Date.parse(op.done_at) : Date.now()) > serverTime;
      for (const key of Object.keys(data)) {
        const now = currentValue(op.entity, item, key);
        if (now === undefined || same(now, data[key])) continue; // cannot compare, or already equal
        if (op.base_data && key in op.base_data && same(now, op.base_data[key])) continue; // only the phone changed it
        conflict = true; // both sides changed this field
        const textField = TEXT_FIELD[op.entity] === key && typeof now === 'string' && typeof data[key] === 'string';
        if (textField) await this.keepOldText(op.entity, op.id, key, clientWins ? (now as string) : (data[key] as string));
        if (!clientWins) {
          ignored.push(key);
          delete data[key];
        }
      }
    }

    // report finish / reopen travel as `status`
    const wantedStatus = op.entity === 'report' ? data.status : undefined;
    if (op.entity === 'report') delete data.status;

    if (Object.keys(data).length) {
      const response = await this.client.call('PATCH', writePath(op.entity, op.id), data);
      if (response.status < 200 || response.status >= 300) return errorResult(op.operation_id, response.status, response.body);
      applied.push(...Object.keys(data));
    }
    if (wantedStatus && wantedStatus !== item.status) {
      const response = await this.client.call('POST', `/reports/${op.id}/${wantedStatus === 'finished' ? 'finish' : 'reopen'}`);
      if (response.status < 200 || response.status >= 300) return errorResult(op.operation_id, response.status, response.body);
      applied.push('status');
    }

    const after = await this.client.call('GET', itemPath(op.entity, op.id));
    const version = after.body?.version as number | undefined;
    if (!conflict) return { operation_id: op.operation_id, status: 'ok', ...(version ? { version } : {}) };
    return {
      operation_id: op.operation_id,
      status: 'conflict',
      ...(version ? { version } : {}),
      server_version: item.version,
      item: after.body,
      applied_fields: applied,
      ignored_fields: ignored,
    };
  }

  /** The text that lost: it stays in the item's history, so no text is ever lost. */
  private async keepOldText(entity: SyncEntity, id: string, field: string, text: string): Promise<void> {
    await this.pool.query('INSERT INTO historico_texto (id, usuario_id, entidade, entidade_id, campo, texto) VALUES (?, ?, ?, ?, ?, ?)', [
      randomUUID(),
      this.userId,
      entity,
      id,
      field,
      text,
    ]);
  }
}
