import type { ProgressMessage, PythonSidecar } from './PythonSidecar';

export interface ChatOptions {
  system: string;
  user: string;
  schemaId: 'highlights' | 'highlights_rerank';
  temperature?: number;
  maxTokens?: number;
}

export interface DownloadModelOptions {
  repo: string;
  filename: string;
}

export interface ModelStatus {
  exists: boolean;
  sizeBytes: number;
  loaded: boolean;
}

const DOWNLOAD_JOB_ID = 'llm-download';

/**
 * Wraps a PythonSidecar to expose the local-LLM RPC surface as typed methods.
 * Owns the model file path so callers don't have to thread it through every
 * call. Filters sidecar progress events by jobId so transcribe progress and
 * llm-download progress can coexist on the same notification channel.
 */
export class SidecarLlmClient {
  constructor(
    private readonly sidecar: Pick<PythonSidecar, 'request' | 'onProgress'>,
    private readonly modelPath: string,
  ) {}

  async chat(opts: ChatOptions): Promise<{ highlights: unknown[] }> {
    const result = await this.sidecar.request<{ json: { highlights: unknown[] } }>('llm_chat', {
      modelPath: this.modelPath,
      system: opts.system,
      user: opts.user,
      schemaId: opts.schemaId,
      temperature: opts.temperature ?? 0.7,
      maxTokens: opts.maxTokens ?? 4096,
    });
    return result.json;
  }

  async modelStatus(): Promise<ModelStatus> {
    return this.sidecar.request<ModelStatus>('llm_model_status', { modelPath: this.modelPath });
  }

  async downloadModel(
    opts: DownloadModelOptions,
    onProgress: (p: { processed: number; total: number }) => void,
  ): Promise<void> {
    const unsub = this.sidecar.onProgress((p: ProgressMessage) => {
      if (p.jobId === DOWNLOAD_JOB_ID) {
        onProgress({ processed: p.processed, total: p.total });
      }
    });
    try {
      await this.sidecar.request('llm_download_model', {
        modelPath: this.modelPath,
        source: opts.repo,
        filename: opts.filename,
      });
    } finally {
      unsub();
    }
  }
}
