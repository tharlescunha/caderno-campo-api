export interface TranscriptionResult {
  text: string;
  confidence: number | null;
}

/** What the worker needs from a speech-to-text tool. The real one is the `transcription` container. */
export interface Transcriber {
  transcribe(audio: Buffer, mimeType: string, language: string): Promise<TranscriptionResult>;
}

export class HttpTranscriber implements Transcriber {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 10 * 60 * 1000,
  ) {}

  async transcribe(audio: Buffer, mimeType: string, language: string): Promise<TranscriptionResult> {
    const response = await fetch(`${this.baseUrl}/transcribe?language=${encodeURIComponent(language)}`, {
      method: 'POST',
      headers: { 'content-type': mimeType },
      body: new Uint8Array(audio),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = (await response.json().catch(() => ({}))) as {
      text?: string;
      confidence?: number | null;
      message?: string;
      error?: string;
    };
    if (!response.ok || typeof body.text !== 'string') {
      throw new Error(`Transcription failed (${response.status}): ${body.message ?? body.error ?? 'no answer'}`);
    }
    return { text: body.text, confidence: body.confidence ?? null };
  }
}
