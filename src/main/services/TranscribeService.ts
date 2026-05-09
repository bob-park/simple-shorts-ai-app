import type { TranscribeProgress } from '@shared/transcribe';
import { type Transcript, TranscriptSchema } from '@shared/transcript';

interface SidecarLike {
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  notify(method: string, params?: Record<string, unknown>): void;
  onProgress(handler: (p: TranscribeProgress) => void): () => void;
}

export interface TranscribeOptions {
  model: string;
  language?: string;
}

export class TranscribeService {
  constructor(private readonly sidecar: SidecarLike) {}

  async transcribe(audioPath: string, opts: TranscribeOptions): Promise<Transcript> {
    const raw = await this.sidecar.request<unknown>('transcribe', {
      audio_path: audioPath,
      model: opts.model,
      language: opts.language ?? 'auto',
    });
    return TranscriptSchema.parse(raw);
  }

  async cancel(): Promise<void> {
    this.sidecar.notify('cancel', {});
  }

  async health(): Promise<{ ok: boolean; modelsLoaded: string[] }> {
    return this.sidecar.request<{ ok: boolean; modelsLoaded: string[] }>('health');
  }

  onProgress(handler: (p: TranscribeProgress) => void): () => void {
    return this.sidecar.onProgress(handler);
  }
}
