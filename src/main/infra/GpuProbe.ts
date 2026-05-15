import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options?: Record<string, unknown>,
) => ChildProcessWithoutNullStreams;

/** `nvidia-smi -L` lists installed NVIDIA GPUs; exit 0 ⇒ a driver + GPU is
 * present and usable. Cheapest reliable "is there an NVIDIA GPU" signal. */
export function nvidiaSmiArgs(): string[] {
  return ['-L'];
}

/** Resolves true iff an NVIDIA GPU + driver is present. Never rejects —
 * nvidia-smi missing (mac / no NVIDIA) or any spawn error resolves false. */
export async function nvidiaGpuPresent(deps: { spawn: SpawnLike }): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = deps.spawn('nvidia-smi', nvidiaSmiArgs(), {});
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('exit', (code: number | null) => resolve(code === 0));
  });
}
