import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { MediaStorage } from '../media/storage.js';
import { indexAudioParent } from '../search/index.js';
import type { Transcriber } from '../transcription/client.js';

/** First try plus three retries, waiting 1, 5 and 15 minutes (docs/api.md, section 7.1). */
export const MAX_ATTEMPTS = 4;

type Log = { info: (msg: string) => void; error: (msg: string) => void };

/**
 * The transcription queue is the `audio` table itself (`status = transcrevendo`). A job is due when it
 * has never been tried, or when the wait for its last failure has passed; `atualizado_em` marks the failure
 * (the trigger moves it on every update). It also covers a crash in the middle of a job.
 */
export class TranscriptionWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly pool: Pool,
    private readonly media: MediaStorage,
    private readonly transcriber: Transcriber,
    private readonly log: Log = { info: () => {}, error: () => {} },
    private readonly intervalMs = 5000,
  ) {}

  start(): void {
    if (this.timer) return;
    const tick = async () => {
      try {
        while (await this.runOnce()) {
          /* keep going while there is work */
        }
      } catch (e) {
        this.log.error(`transcription loop: ${(e as Error).message}`);
      }
      this.timer = setTimeout(tick, this.intervalMs);
    };
    this.timer = setTimeout(tick, 0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Takes one due job, if any. Returns true when a job was processed (successfully or not). */
  async runOnce(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      const [due] = await this.pool.query<RowDataPacket[]>(
        `SELECT id, usuario_id, registro_id, anotacao_id, arquivo, tipo_mime, idioma, tentativas FROM audio
          WHERE status = 'transcrevendo' AND arquivo IS NOT NULL AND tentativas < ?
            AND (tentativas = 0 OR atualizado_em <= NOW(3) - INTERVAL (CASE tentativas WHEN 1 THEN 1 WHEN 2 THEN 5 ELSE 15 END) MINUTE)
          ORDER BY criado_em LIMIT 1`,
        [MAX_ATTEMPTS],
      );
      const job = due[0];
      if (!job) return false;

      // claim it: the attempt counter only moves if nobody else did meanwhile
      const [claimed] = await this.pool.query<{ affectedRows: number } & RowDataPacket[]>(
        "UPDATE audio SET tentativas = tentativas + 1 WHERE id = ? AND status = 'transcrevendo' AND tentativas = ?",
        [job.id, job.tentativas],
      );
      if (!claimed.affectedRows) return true;
      await this.process(job, (job.tentativas as number) + 1);
      return true;
    } finally {
      this.running = false;
    }
  }

  private async process(job: RowDataPacket, attempt: number): Promise<void> {
    try {
      const audio = await this.media.read(job.arquivo as string);
      const result = await this.transcriber.transcribe(audio, job.tipo_mime as string, job.idioma as string);
      // `transcricao_editada` (what the user fixed) is never touched here
      await this.pool.query(
        "UPDATE audio SET status = 'pronto', transcricao = ?, confianca = ?, erro = NULL, transcrito_em = NOW(3) WHERE id = ?",
        [result.text, result.confidence, job.id],
      );
      await indexAudioParent(this.pool, job.usuario_id as string, {
        entryId: job.registro_id as string | null,
        noteId: job.anotacao_id as string | null,
      });
      this.log.info(`audio ${job.id}: transcribed (attempt ${attempt}).`);

      const [prefs] = await this.pool.query<RowDataPacket[]>('SELECT apagar_audio_apos_transcricao AS del FROM usuario WHERE id = ?', [
        job.usuario_id,
      ]);
      if (prefs[0]?.del === 1) {
        await this.media.remove([job.arquivo as string]);
        await this.pool.query('UPDATE audio SET arquivo = NULL WHERE id = ?', [job.id]);
      }
    } catch (e) {
      const message = (e as Error).message.slice(0, 250);
      const giveUp = attempt >= MAX_ATTEMPTS;
      await this.pool.query('UPDATE audio SET erro = ?, status = ? WHERE id = ?', [message, giveUp ? 'erro' : 'transcrevendo', job.id]);
      this.log.error(`audio ${job.id}: attempt ${attempt} failed${giveUp ? ', giving up' : ''}: ${message}`);
    }
  }
}
