import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TranscribeService } from './TranscribeService';

const validRaw = {
  duration: 4.0,
  language: 'en',
  segments: [{ start: 0.0, end: 4.0, text: 'hi' }],
  words: [{ start: 0.0, end: 0.5, text: 'hi' }],
};

describe('TranscribeService', () => {
  let request: ReturnType<typeof vi.fn>;
  let onProgress: ReturnType<typeof vi.fn>;
  let notify: ReturnType<typeof vi.fn>;
  let sidecar: { request: typeof request; notify: typeof notify; onProgress: typeof onProgress };
  let service: TranscribeService;

  beforeEach(() => {
    request = vi.fn();
    notify = vi.fn();
    onProgress = vi.fn(() => () => undefined);
    sidecar = { request, notify, onProgress };
    service = new TranscribeService(sidecar as never);
  });

  it('calls sidecar.request with the right method and params', async () => {
    request.mockResolvedValue(validRaw);
    const result = await service.transcribe('/tmp/a.mp4', {
      model: 'small',
      language: 'auto',
      device: 'cpu',
    });
    expect(request).toHaveBeenCalledWith('transcribe', {
      audio_path: '/tmp/a.mp4',
      model: 'small',
      language: 'auto',
      device: 'cpu',
    });
    expect(result.duration).toBe(4.0);
    expect(result.segments[0].text).toBe('hi');
  });

  it("defaults device to 'auto' when caller omits it", async () => {
    request.mockResolvedValue(validRaw);
    await service.transcribe('/tmp/a.mp4', { model: 'small' });
    expect(request).toHaveBeenCalledWith('transcribe', {
      audio_path: '/tmp/a.mp4',
      model: 'small',
      language: 'auto',
      device: 'auto',
    });
  });

  it('rejects malformed sidecar payloads via the schema', async () => {
    request.mockResolvedValue({ duration: 'not a number' });
    await expect(service.transcribe('/x', { model: 'small' })).rejects.toThrow();
  });

  it('subscribes to sidecar progress and forwards it to the caller', async () => {
    request.mockResolvedValue(validRaw);
    const events: unknown[] = [];
    const unsub = service.onProgress((p) => events.push(p));
    expect(onProgress).toHaveBeenCalled();
    const sidecarHandler = onProgress.mock.calls[0]![0] as (p: unknown) => void;
    sidecarHandler({ jobId: 'x', processed: 1.0, total: 4.0 });
    expect(events).toEqual([{ jobId: 'x', processed: 1.0, total: 4.0 }]);
    unsub();
  });

  it('cancel() sends a cancel notification', async () => {
    await service.cancel();
    expect(notify).toHaveBeenCalledWith('cancel', {});
  });

  it('health() proxies to sidecar.request', async () => {
    request.mockResolvedValue({ ok: true, modelsLoaded: ['small'] });
    await expect(service.health()).resolves.toEqual({ ok: true, modelsLoaded: ['small'] });
    expect(request).toHaveBeenCalledWith('health');
  });
});
