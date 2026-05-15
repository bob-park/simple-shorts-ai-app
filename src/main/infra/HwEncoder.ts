import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options?: Record<string, unknown>,
) => ChildProcessWithoutNullStreams;

/**
 * NVENC ignores `-crf`; `-cq` is its constant-quality VBR knob (≈ crf). `-preset p5`
 * is the balanced NVENC preset (p1 fastest … p7 slowest). Encoder-only HW accel:
 * all filters stay on the CPU and ffmpeg auto-uploads software frames to NVENC.
 */
export const NVENC_VIDEO_ARGS = ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '23'] as const;

/** Software fallback — unchanged from the original COMMON_ENCODE_ARGS video part. */
export const X264_VIDEO_ARGS = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23'] as const;

/**
 * A fast NVENC capability probe: a 0.1s lavfi null-source encoded through
 * h264_nvenc to `-f null -`. Exit 0 ⇒ NVENC is actually usable on this
 * machine (driver present, GPU supports it, an NVENC session is available).
 * Catches "no NVIDIA", "old/incompatible driver", "ffmpeg built without
 * nvenc", and Blackwell-unsupported cases in one shot.
 */
export function nvencProbeArgs(): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=320x240:r=5:d=0.1',
    '-c:v',
    'h264_nvenc',
    '-f',
    'null',
    '-',
  ];
}

/** Resolves true iff the bundled ffmpeg can actually encode with h264_nvenc.
 * Never rejects — any spawn/exec failure resolves false (→ libx264). */
export async function nvencAvailable(deps: { ffmpegCmd: string; spawn: SpawnLike }): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = deps.spawn(deps.ffmpegCmd, nvencProbeArgs(), {});
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('exit', (code: number | null) => resolve(code === 0));
  });
}
