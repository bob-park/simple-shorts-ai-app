import { type TrackResult, TrackResultSchema } from '@shared/track';

interface SidecarLike {
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export interface TrackOptions {
  /** Seconds from start of source video (inclusive). */
  startSec: number;
  /** Seconds from start of source video (inclusive). */
  endSec: number;
  /** Frames sampled per second; default 2.0. */
  fpsSample?: number;
}

/**
 * Thin facade over the Python sidecar's `track_faces` RPC. Validates the
 * response with `TrackResultSchema` so downstream code can trust the shape.
 */
export class TrackingService {
  constructor(private readonly sidecar: SidecarLike) {}

  async track(videoPath: string, opts: TrackOptions): Promise<TrackResult> {
    const raw = await this.sidecar.request<unknown>('track_faces', {
      video_path: videoPath,
      start_sec: opts.startSec,
      end_sec: opts.endSec,
      fps_sample: opts.fpsSample ?? 2.0,
    });
    return TrackResultSchema.parse(raw);
  }
}
