import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { nvidiaGpuPresent, nvidiaSmiArgs } from './GpuProbe';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

function spawnReturning(exitCode: number | null, opts: { throwOnSpawn?: boolean; emitError?: boolean } = {}) {
  const child = new FakeChild();
  return vi.fn(() => {
    if (opts.throwOnSpawn) throw new Error('spawn EACCES');
    queueMicrotask(() => {
      if (opts.emitError) child.emit('error', new Error('ENOENT'));
      else child.emit('exit', exitCode);
    });
    return child as never;
  });
}

describe('GpuProbe', () => {
  it('probes via `nvidia-smi -L`', () => {
    expect(nvidiaSmiArgs()).toEqual(['-L']);
  });

  it('true when nvidia-smi exits 0 (driver + GPU present)', async () => {
    const spawn = spawnReturning(0);
    await expect(nvidiaGpuPresent({ spawn: spawn as never })).resolves.toBe(true);
    expect(spawn).toHaveBeenCalledWith('nvidia-smi', ['-L'], expect.anything());
  });

  it('false when nvidia-smi exits non-zero', async () => {
    await expect(nvidiaGpuPresent({ spawn: spawnReturning(9) as never })).resolves.toBe(false);
  });

  it('false when nvidia-smi is absent / spawn errors / throws (never rejects)', async () => {
    await expect(nvidiaGpuPresent({ spawn: spawnReturning(null, { emitError: true }) as never })).resolves.toBe(false);
    await expect(nvidiaGpuPresent({ spawn: spawnReturning(0, { throwOnSpawn: true }) as never })).resolves.toBe(false);
  });
});
