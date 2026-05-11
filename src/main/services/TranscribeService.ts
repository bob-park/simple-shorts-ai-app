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
  /**
   * Whisper compute device — `'auto'`, `'cpu'`, `'cuda'`, or `'metal'`.
   * Forwarded to the sidecar which passes it as `WhisperModel(device=…)`.
   * Callers should resolve `'auto'` to a concrete device per platform
   * before invoking — `'auto'` on Windows triggers CTranslate2's CUDA
   * probe which tries to load cublas64_12.dll and fails on machines
   * without an NVIDIA stack. main.ts does this resolution.
   */
  device?: string;
}

export class TranscribeService {
  constructor(private readonly sidecar: SidecarLike) {}

  async transcribe(audioPath: string, opts: TranscribeOptions): Promise<Transcript> {
    const raw = await this.sidecar.request<unknown>('transcribe', {
      audio_path: audioPath,
      model: opts.model,
      language: opts.language ?? 'auto',
      device: opts.device ?? 'auto',
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
