import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TrackingService } from './TrackingService';

const validRaw = {
  sourceWidth: 1920,
  sourceHeight: 1080,
  frames: [
    { t: 0.0, cx: 960.0, cy: 540.0 },
    { t: 0.5, cx: 970.0, cy: 545.0 },
  ],
};

describe('TrackingService', () => {
  let request: ReturnType<typeof vi.fn>;
  let sidecar: { request: typeof request };
  let service: TrackingService;

  beforeEach(() => {
    request = vi.fn();
    sidecar = { request };
    service = new TrackingService(sidecar as never);
  });

  it('calls sidecar.request with track_faces and the right params', async () => {
    request.mockResolvedValue(validRaw);
    const result = await service.track('/tmp/x.mp4', { startSec: 5, endSec: 35, fpsSample: 2 });
    expect(request).toHaveBeenCalledWith('track_faces', {
      video_path: '/tmp/x.mp4',
      start_sec: 5,
      end_sec: 35,
      fps_sample: 2,
    });
    expect(result.sourceWidth).toBe(1920);
    expect(result.frames).toHaveLength(2);
  });

  it('defaults fps_sample to 2.0 when not provided', async () => {
    request.mockResolvedValue(validRaw);
    await service.track('/tmp/x.mp4', { startSec: 0, endSec: 10 });
    expect(request).toHaveBeenCalledWith('track_faces', {
      video_path: '/tmp/x.mp4',
      start_sec: 0,
      end_sec: 10,
      fps_sample: 2.0,
    });
  });

  it('rejects malformed payloads via the schema', async () => {
    request.mockResolvedValue({ sourceWidth: 'not a number' });
    await expect(service.track('/x.mp4', { startSec: 0, endSec: 10 })).rejects.toThrow();
  });

  it('accepts an empty frames array (no faces detected)', async () => {
    request.mockResolvedValue({ sourceWidth: 1920, sourceHeight: 1080, frames: [] });
    const result = await service.track('/x.mp4', { startSec: 0, endSec: 10 });
    expect(result.frames).toEqual([]);
  });
});
