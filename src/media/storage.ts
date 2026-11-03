import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import sharp from 'sharp';

export const PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;
export type PhotoMime = (typeof PHOTO_MIME_TYPES)[number];

const EXTENSION: Record<PhotoMime, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' };

/** The real type of an image, read from the first bytes (never from the name or the declared type). */
export function sniffPhotoMime(buffer: Buffer): PhotoMime | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12);
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
  }
  return null;
}

/**
 * Files live in one folder per user (docs/banco-de-dados.md, section 8) and are named by id,
 * never by what the client called them. They are served only through authenticated routes.
 */
export class MediaStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Relative paths are what the database stores. */
  photoPath(userId: string, photoId: string, mime: PhotoMime): string {
    return join(userId, 'fotos', `${photoId}.${EXTENSION[mime]}`);
  }

  audioPath(userId: string, audioId: string, mime: AudioMime): string {
    return join(userId, 'audios', `${audioId}.${AUDIO_EXTENSION[mime]}`);
  }

  attachmentPath(userId: string, attachmentId: string, mime: AttachmentMime): string {
    return join(userId, 'anexos', `${attachmentId}.${mime === 'application/pdf' ? 'pdf' : EXTENSION[mime]}`);
  }

  attachmentThumbnailPath(userId: string, attachmentId: string): string {
    return join(userId, 'anexos', `${attachmentId}_thumb.jpg`);
  }

  thumbnailPath(userId: string, photoId: string): string {
    return join(userId, 'fotos', `${photoId}_thumb.jpg`);
  }

  private absolute(relative: string): string {
    const full = resolve(this.root, relative);
    if (!full.startsWith(this.root + sep)) throw new Error('Path outside the media folder.');
    return full;
  }

  async save(relative: string, data: Buffer): Promise<void> {
    const full = this.absolute(relative);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
  }

  /** Best effort: a missing file is not an error. */
  async remove(relatives: (string | null | undefined)[]): Promise<void> {
    await Promise.all(relatives.filter((p): p is string => !!p).map((p) => rm(this.absolute(p), { force: true })));
  }

  /** Deletes the whole folder of a user (photos, audios, attachments). The id must be a UUID. */
  async removeUserFolder(userId: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('Invalid user id.');
    await rm(this.absolute(userId), { recursive: true, force: true });
  }

  async read(relative: string): Promise<Buffer> {
    return readFile(this.absolute(relative));
  }

  stream(relative: string) {
    return createReadStream(this.absolute(relative));
  }
}

export type AttachmentMime = PhotoMime | 'application/pdf';

/** Photos or PDF, from the first bytes. */
export function sniffAttachmentMime(buffer: Buffer): AttachmentMime | null {
  if (buffer.length >= 5 && buffer.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  return sniffPhotoMime(buffer);
}

export const AUDIO_MIME_TYPES = ['audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm'] as const;
export type AudioMime = (typeof AUDIO_MIME_TYPES)[number];
const AUDIO_EXTENSION: Record<AudioMime, string> = { 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/webm': 'webm' };

/** The real type of an audio file, from its first bytes (m4a/mp4, ADTS aac, ogg/opus, webm). */
export function sniffAudioMime(buffer: Buffer): AudioMime | null {
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp' && sniffPhotoMime(buffer) !== 'image/heic') return 'audio/mp4';
  if (buffer.length >= 2 && buffer[0] === 0xff && ((buffer[1] ?? 0) & 0xf6) === 0xf0) return 'audio/aac';
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'audio/webm';
  return null;
}

/** A 400 px JPEG thumbnail, or null when the image cannot be decoded here (for example HEIC). */
export async function makeThumbnail(buffer: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(buffer).rotate().resize(400, 400, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
  } catch {
    return null;
  }
}

/** True when sharp can open it (used to refuse files that only look like images). */
export async function isDecodable(buffer: Buffer): Promise<boolean> {
  try {
    await sharp(buffer).metadata();
    return true;
  } catch {
    return false;
  }
}
