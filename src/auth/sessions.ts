import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { ACCESS_TOKEN_SECONDS, newRefreshToken, sha256, signAccessToken } from './crypto.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TokenPair {
  access_token: string;
  expires_in: number;
  refresh_token: string;
}

export interface ClientInfo {
  ip: string | undefined;
  userAgent: string | undefined;
}

/** Creates a refresh token row (1 day, or 30 days with "keep me logged in") and the access token. */
export async function issueTokens(
  db: Pool | PoolConnection,
  jwtSecret: string,
  userId: string,
  keepLoggedIn: boolean,
  client: ClientInfo,
): Promise<{ tokens: TokenPair; refreshId: string }> {
  const refresh = newRefreshToken();
  const refreshId = randomUUID();
  const expires = new Date(Date.now() + (keepLoggedIn ? 30 : 1) * DAY_MS);
  await db.query('INSERT INTO refresh_token (id, usuario_id, token_hash, expira_em, ip, agente) VALUES (?, ?, ?, ?, ?, ?)', [
    refreshId,
    userId,
    sha256(refresh),
    expires,
    client.ip ?? null,
    client.userAgent?.slice(0, 255) ?? null,
  ]);
  return {
    tokens: { access_token: await signAccessToken(userId, jwtSecret), expires_in: ACCESS_TOKEN_SECONDS, refresh_token: refresh },
    refreshId,
  };
}
