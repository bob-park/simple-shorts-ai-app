import type { SetupProgress } from '@shared/setup';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { SetupWizardService } from './SetupWizardService';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

function makeSpawn() {
  const children: FakeChild[] = [];
  const spawn = vi.fn(() => {
    const c = new FakeChild();
    children.push(c);
    return c as unknown as ReturnType<typeof import('node:child_process').spawn>;
  });
  return { spawn, children };
}

const opts = {
  uvBinary: '/r/uv',
  pythonRuntime: '/r/python-runtime/bin/python3.11',
  venvPath: '/data/sidecar-venv',
  requirementsPath: '/r/requirements.txt',
};

describe('SetupWizardService.status', () => {
  it("returns 'ready' when bin/python exists", async () => {
    const access = vi.fn(async (_p: string) => undefined);
    const svc = new SetupWizardService({
      ...opts,
      spawn: vi.fn(),
      fs: { access },
    } as never);
    expect(await svc.status()).toBe('ready');
    expect(access).toHaveBeenCalledWith('/data/sidecar-venv/bin/python');
  });

  it("returns 'pending' when bin/python is missing", async () => {
    const access = vi.fn(async () => {
      throw new Error('ENOENT');
    });
    const svc = new SetupWizardService({
      ...opts,
      spawn: vi.fn(),
      fs: { access },
    } as never);
    expect(await svc.status()).toBe('pending');
  });
});

describe('SetupWizardService.run', () => {
  it('spawns uv venv then uv pip install with the right args', async () => {
    const { spawn, children } = makeSpawn();
    const svc = new SetupWizardService({
      ...opts,
      spawn,
      fs: { access: vi.fn(async () => undefined) },
    } as never);
    const promise = svc.run();
    setImmediate(() => children[0]!.emit('exit', 0));
    await new Promise((r) => setImmediate(r));
    setImmediate(() => children[1]!.emit('exit', 0));
    await promise;
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      '/r/uv',
      ['venv', '/data/sidecar-venv', '--python', '/r/python-runtime/bin/python3.11'],
      expect.anything(),
    );
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      '/r/uv',
      ['pip', 'install', '--python', '/data/sidecar-venv/bin/python', '-r', '/r/requirements.txt'],
      expect.anything(),
    );
  });

  it('rejects with stderr tail when uv venv fails', async () => {
    const { spawn, children } = makeSpawn();
    const svc = new SetupWizardService({
      ...opts,
      spawn,
      fs: { access: vi.fn(async () => undefined) },
    } as never);
    const promise = svc.run();
    setImmediate(() => {
      children[0]!.stderr.emit('data', Buffer.from('boom: something broke'));
      children[0]!.emit('exit', 1);
    });
    await expect(promise).rejects.toThrow(/boom: something broke/);
  });

  it('emits pip progress events when uv pip install streams "Installed X-Y" lines', async () => {
    const { spawn, children } = makeSpawn();
    const svc = new SetupWizardService({
      ...opts,
      spawn,
      fs: { access: vi.fn(async () => undefined) },
    } as never);
    const events: SetupProgress[] = [];
    svc.onProgress((p) => events.push(p));
    const promise = svc.run();
    setImmediate(() => children[0]!.emit('exit', 0));
    await new Promise((r) => setImmediate(r));
    setImmediate(() => {
      children[1]!.stdout.emit('data', Buffer.from('Resolved 5 packages\n'));
      children[1]!.stdout.emit('data', Buffer.from('Installed faster-whisper-1.0.3\n'));
      children[1]!.stdout.emit('data', Buffer.from('Installed mediapipe-0.10.18\n'));
      children[1]!.emit('exit', 0);
    });
    await promise;
    const pipEvents = events.filter((e) => e.phase === 'pip');
    expect(pipEvents.length).toBeGreaterThan(0);
    const last = pipEvents[pipEvents.length - 1] as Extract<SetupProgress, { phase: 'pip' }>;
    expect(last.total).toBe(5);
    expect(last.current).toBe(2);
    expect(last.pct).toBeCloseTo(0.4);
  });

  it('emits a venv pct=1 event after uv venv exits', async () => {
    const { spawn, children } = makeSpawn();
    const svc = new SetupWizardService({
      ...opts,
      spawn,
      fs: { access: vi.fn(async () => undefined) },
    } as never);
    const events: SetupProgress[] = [];
    svc.onProgress((p) => events.push(p));
    const promise = svc.run();
    setImmediate(() => children[0]!.emit('exit', 0));
    await new Promise((r) => setImmediate(r));
    setImmediate(() => children[1]!.emit('exit', 0));
    await promise;
    const venvEvents = events.filter((e) => e.phase === 'venv');
    expect(venvEvents.length).toBe(1);
    expect(venvEvents[0]!.pct).toBe(1);
  });
});
