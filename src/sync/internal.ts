import type { FastifyInstance } from 'fastify';
import { signAccessToken } from '../auth/crypto.js';

export type SyncEntity = 'user' | 'period' | 'teacher' | 'subject' | 'report' | 'entry' | 'todo' | 'event' | 'note' | 'photo' | 'audio';
export const SYNC_ENTITIES: SyncEntity[] = [
  'user',
  'period',
  'teacher',
  'subject',
  'report',
  'entry',
  'todo',
  'event',
  'note',
  'photo',
  'audio',
];

/** JSON coming back from our own routes: its shape depends on the entity, so it is read loosely here. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export interface InternalResponse {
  status: number;
  body: Json; // JSON of the answer (or null for 204)
}

/**
 * Sync does not have a second copy of the business rules: every operation goes through the normal routes
 * of the API, as the same user, so validation, read-only periods, search index and so on all apply.
 */
export class InternalClient {
  private token: Promise<string>;

  constructor(
    private readonly app: FastifyInstance,
    userId: string,
    jwtSecret: string,
  ) {
    this.token = signAccessToken(userId, jwtSecret);
  }

  async call(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ): Promise<InternalResponse> {
    const response = await this.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${await this.token}`, ...headers },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    let body: unknown = null;
    if (response.body) {
      try {
        body = JSON.parse(response.body);
      } catch {
        body = null;
      }
    }
    return { status: response.statusCode, body };
  }
}

/** URL that reads one item of an entity (the same JSON the normal route gives). */
export function itemPath(entity: SyncEntity, id: string): string {
  switch (entity) {
    case 'user':
      return '/users/me';
    case 'period':
      return `/periods/${id}`;
    case 'teacher':
      return `/teachers/${id}`;
    case 'subject':
      return `/subjects/${id}`;
    case 'report':
      return `/reports/${id}`;
    case 'entry':
      return `/entries/${id}`;
    case 'todo':
      return `/todos/${id}`;
    case 'event':
      return `/events/${id}`;
    case 'note':
      return `/notes/${id}`;
    case 'photo':
      return `/photos/${id}/info`;
    case 'audio':
      return `/audios/${id}`;
  }
}

/** URL for PATCH and DELETE of an item (the photo's metadata lives at `/photos/{id}`). */
export function writePath(entity: SyncEntity, id: string): string {
  return entity === 'photo' ? `/photos/${id}` : itemPath(entity, id);
}
