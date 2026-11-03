import type { RowDataPacket } from 'mysql2/promise';
import { ApiError } from '../http/errors.js';
import { enumMap, type Db } from '../lib/common.js';
import { isoDate } from '../users/user.js';

export const MAX_AUDIOS_PER_PARENT = 5;
export const MAX_AUDIO_SECONDS = 300;
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export const audioStatus = enumMap({ transcribing: 'transcrevendo', ready: 'pronto', error: 'erro' });

export function serializeAudio(r: RowDataPacket) {
  return {
    id: r.id as string,
    entry_id: (r.registro_id as string | null) ?? null,
    note_id: (r.anotacao_id as string | null) ?? null,
    duration_s: r.duracao_s as number,
    recorded_at: isoDate(r.gravado_em as string),
    status: audioStatus.toApi(r.status as string),
    language: r.idioma as string,
    confidence: r.confianca == null ? null : Number(r.confianca),
    transcription: (r.transcricao as string | null) ?? null,
    edited_transcription: (r.transcricao_editada as string | null) ?? null,
    attempts: r.tentativas as number,
    error: (r.erro as string | null) ?? null,
    transcribed_at: isoDate(r.transcrito_em as string | null),
    mime_type: r.tipo_mime as string,
    size_bytes: r.tamanho_bytes as number,
    // null once the file was deleted (option "delete the audio after transcribing")
    url: r.arquivo ? `/api/v1/audios/${r.id}/file` : null,
    created_at: isoDate(r.criado_em as string),
    updated_at: isoDate(r.atualizado_em as string),
    version: r.versao as number,
  };
}

export type AudioItem = ReturnType<typeof serializeAudio>;

export async function fetchAudios(db: Db, userId: string, where: string, params: unknown[]): Promise<AudioItem[]> {
  const [rows] = await db.query<RowDataPacket[]>(`SELECT * FROM audio WHERE usuario_id = ? AND ${where} ORDER BY gravado_em, id`, [
    userId,
    ...params,
  ]);
  return rows.map(serializeAudio);
}

export async function findAudioRow(db: Db, userId: string, id: string): Promise<RowDataPacket> {
  const [rows] = await db.query<RowDataPacket[]>('SELECT * FROM audio WHERE usuario_id = ? AND id = ?', [userId, id]);
  if (!rows[0]) throw new ApiError(404, 'not_found', 'Audio not found.');
  return rows[0];
}

export async function audioFiles(db: Db, userId: string, where: string, params: unknown[]): Promise<string[]> {
  const [rows] = await db.query<RowDataPacket[]>(`SELECT arquivo FROM audio WHERE usuario_id = ? AND ${where}`, [userId, ...params]);
  return rows.map((r) => r.arquivo as string | null).filter((p): p is string => !!p);
}

export const AUDIOS_OF_ENTRY = 'registro_id = ?';
export const AUDIOS_OF_REPORT = 'registro_id IN (SELECT id FROM registro WHERE usuario_id = audio.usuario_id AND relatorio_id = ?)';
