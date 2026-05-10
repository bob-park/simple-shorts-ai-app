import { describe, expect, it, vi } from 'vitest';

import { SidecarLlmClient } from './SidecarLlmClient';

interface MockSidecar {
  request: ReturnType<typeof vi.fn>;
  onProgress: ReturnType<typeof vi.fn>;
}

function makeMockSidecar(): MockSidecar {
  return {
    request: vi.fn(),
    onProgress: vi.fn().mockReturnValue(() => undefined),
  };
}

describe('SidecarLlmClient', () => {
  it('chat() forwards system/user/schemaId to llm_chat RPC and returns parsed json', async () => {
    const sidecar = makeMockSidecar();
    sidecar.request.mockResolvedValue({
      json: { highlights: [{ segment_indices: [0, 1], title: 'T', hook: 'H' }] },
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const client = new SidecarLlmClient(sidecar as never, '/tmp/m.gguf');
    const result = await client.chat({ system: 's', user: 'u', schemaId: 'highlights' });
    expect(sidecar.request).toHaveBeenCalledWith('llm_chat', {
      modelPath: '/tmp/m.gguf',
      system: 's',
      user: 'u',
      schemaId: 'highlights',
      temperature: 0.7,
      maxTokens: 4096,
    });
    expect(result).toEqual({ highlights: [{ segment_indices: [0, 1], title: 'T', hook: 'H' }] });
  });

  it('modelStatus() forwards modelPath to llm_model_status RPC', async () => {
    const sidecar = makeMockSidecar();
    sidecar.request.mockResolvedValue({ exists: true, sizeBytes: 1234, loaded: false });
    const client = new SidecarLlmClient(sidecar as never, '/tmp/m.gguf');
    const status = await client.modelStatus();
    expect(sidecar.request).toHaveBeenCalledWith('llm_model_status', { modelPath: '/tmp/m.gguf' });
    expect(status).toEqual({ exists: true, sizeBytes: 1234, loaded: false });
  });

  it('downloadModel() forwards repo/filename and routes filtered progress events', async () => {
    const sidecar = makeMockSidecar();
    let progressHandler: ((p: { jobId: string; processed: number; total: number }) => void) | null = null;
    sidecar.onProgress.mockImplementation((h: (p: { jobId: string; processed: number; total: number }) => void) => {
      progressHandler = h;
      return () => {
        progressHandler = null;
      };
    });
    sidecar.request.mockImplementation(async () => {
      progressHandler!({ jobId: 'llm-download', processed: 50, total: 100 });
      progressHandler!({ jobId: 'transcribe-other', processed: 99, total: 100 }); // unrelated, must be ignored
      progressHandler!({ jobId: 'llm-download', processed: 100, total: 100 });
      return { ok: true };
    });
    const events: { processed: number; total: number }[] = [];
    const client = new SidecarLlmClient(sidecar as never, '/tmp/m.gguf');
    await client.downloadModel({ repo: 'unsloth/gemma-4-E4B-it-GGUF', filename: 'gemma-4-E4B-it-Q4_K_M.gguf' }, (p) =>
      events.push({ processed: p.processed, total: p.total }),
    );
    expect(events).toEqual([
      { processed: 50, total: 100 },
      { processed: 100, total: 100 },
    ]);
    expect(sidecar.request).toHaveBeenCalledWith('llm_download_model', {
      modelPath: '/tmp/m.gguf',
      source: 'unsloth/gemma-4-E4B-it-GGUF',
      filename: 'gemma-4-E4B-it-Q4_K_M.gguf',
    });
  });

  it('downloadModel() unsubscribes the progress listener after request resolves', async () => {
    const sidecar = makeMockSidecar();
    const unsub = vi.fn();
    sidecar.onProgress.mockReturnValue(unsub);
    sidecar.request.mockResolvedValue({ ok: true });
    const client = new SidecarLlmClient(sidecar as never, '/tmp/m.gguf');
    await client.downloadModel({ repo: 'r', filename: 'f' }, () => undefined);
    expect(unsub).toHaveBeenCalled();
  });
});
