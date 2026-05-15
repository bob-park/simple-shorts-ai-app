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
  venvPythonBinary: '/data/sidecar-venv/bin/python',
  requirementsPath: '/r/requirements.txt',
};

const WIN_OPTS = {
  uvBinary: 'C:\\Program Files\\Shorts AI\\resources\\uv.exe',
  pythonRuntime: 'C:\\Program Files\\Shorts AI\\resources\\python-runtime\\python.exe',
  venvPath: 'C:\\Users\\u\\AppData\\Roaming\\Shorts AI\\sidecar-venv',
  venvPythonBinary: 'C:\\Users\\u\\AppData\\Roaming\\Shorts AI\\sidecar-venv\\Scripts\\python.exe',
  requirementsPath: 'C:\\Program Files\\Shorts AI\\resources\\requirements.txt',
};

describe('SetupWizardService.status', () => {
  it("returns 'ready' when the venv python exists (probes opts.venvPythonBinary, not a hardcoded path)", async () => {
    const access = vi.fn(async (_p: string) => undefined);
    const svc = new SetupWizardService({
      ...opts,
      spawn: vi.fn(),
      fs: { access },
    } as never);
    expect(await svc.status()).toBe('ready');
    expect(access).toHaveBeenCalledWith('/data/sidecar-venv/bin/python');
    expect(access).toHaveBeenCalledWith('/data/sidecar-venv/.stt-selftest-ok');
  });

  it('Windows: probes the Scripts\\python.exe path supplied via opts.venvPythonBinary', async () => {
    const access = vi.fn(async (_p: string) => undefined);
    const svc = new SetupWizardService({
      ...WIN_OPTS,
      spawn: vi.fn(),
      fs: { access },
    } as never);
    expect(await svc.status()).toBe('ready');
    expect(access).toHaveBeenCalledWith(
      'C:\\Users\\u\\AppData\\Roaming\\Shorts AI\\sidecar-venv\\Scripts\\python.exe',
    );
  });

  it("returns 'pending' when the venv python is missing", async () => {
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
      fs: { access: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined) },
    } as never);
    const promise = svc.run();
    setImmediate(() => children[0]!.emit('exit', 0));
    await new Promise((r) => setImmediate(r));
    setImmediate(() => children[1]!.emit('exit', 0));
    await new Promise((r) => setImmediate(r));
    setImmediate(() => children[2]!.emit('exit', 0));
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

  it('Windows: uv pip install is given the Scripts\\python.exe path from opts.venvPythonBinary', async () => {
    const { spawn, children } = makeSpawn();
    const svc = new SetupWizardService({
      ...WIN_OPTS,
      spawn,
      fs: { access: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined) },
    } as never);
    const promise = svc.run();
    setImmediate(() => children[0]!.emit('exit', 0));
    await new Promise((r) => setImmediate(r));
    setImmediate(() => children[1]!.emit('exit', 0));
    await new Promise((r) => setImmediate(r));
    setImmediate(() => children[2]!.emit('exit', 0));
    await promise;
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      WIN_OPTS.uvBinary,
      [
        'pip',
        'install',
        '--python',
        'C:\\Users\\u\\AppData\\Roaming\\Shorts AI\\sidecar-venv\\Scripts\\python.exe',
        '-r',
        WIN_OPTS.requirementsPath,
      ],
      expect.anything(),
    );
  });

  it('inserts --extra-index-url flags from opts.extraIndexUrls into the uv pip install argv', async () => {
    const { spawn, children } = makeSpawn();
    const svc = new SetupWizardService({
      ...opts,
      extraIndexUrls: [
        'https://abetlen.github.io/llama-cpp-python/whl/cu124',
        'https://example.com/extra',
      ],
      spawn,
      fs: { access: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined) },
    } as never);
    const promise = svc.run();
    setImmediate(() => children[0]!.emit('exit', 0));
    await new Promise((r) => setImmediate(r));
    setImmediate(() => children[1]!.emit('exit', 0));
    await new Promise((r) => setImmediate(r));
    setImmediate(() => children[2]!.emit('exit', 0));
    await promise;
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      '/r/uv',
      [
        'pip',
        'install',
        '--extra-index-url',
        'https://abetlen.github.io/llama-cpp-python/whl/cu124',
        '--extra-index-url',
        'https://example.com/extra',
        '--python',
        '/data/sidecar-venv/bin/python',
        '-r',
        '/r/requirements.txt',
      ],
      expect.anything(),
    );
  });

  it('rejects with stderr tail when uv venv fails', async () => {
    const { spawn, children } = makeSpawn();
    const svc = new SetupWizardService({
      ...opts,
      spawn,
      fs: { access: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined) },
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
      fs: { access: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined) },
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
    await new Promise((r) => setImmediate(r));
    setImmediate(() => children[2]!.emit('exit', 0));
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
      fs: { access: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined) },
    } as never);
    const events: SetupProgress[] = [];
    svc.onProgress((p) => events.push(p));
    const promise = svc.run();
    setImmediate(() => children[0]!.emit('exit', 0));
    await new Promise((r) => setImmediate(r));
    setImmediate(() => children[1]!.emit('exit', 0));
    await new Promise((r) => setImmediate(r));
    setImmediate(() => children[2]!.emit('exit', 0));
    await promise;
    const venvEvents = events.filter((e) => e.phase === 'venv');
    expect(venvEvents.length).toBe(1);
    expect(venvEvents[0]!.pct).toBe(1);
  });
});

describe('SetupWizardService.selfTest + status gating', () => {
  it('run() spawns the STT import probe with the venv python after pip install', async () => {
    const { spawn, children } = makeSpawn();
    const writeFile = vi.fn(async () => undefined);
    const svc = new SetupWizardService({
      ...opts,
      spawn,
      fs: { access: vi.fn(async () => undefined), writeFile },
    } as never);
    const promise = svc.run();
    setImmediate(() => children[0]!.emit('exit', 0));
    await new Promise((r) => setImmediate(r));
    setImmediate(() => children[1]!.emit('exit', 0));
    await new Promise((r) => setImmediate(r));
    setImmediate(() => children[2]!.emit('exit', 0));
    await promise;
    expect(spawn).toHaveBeenNthCalledWith(
      3,
      '/data/sidecar-venv/bin/python',
      ['-c', 'import faster_whisper, ctranslate2, av; print("stt-ok")'],
      expect.anything(),
    );
    expect(writeFile).toHaveBeenCalledWith('/data/sidecar-venv/.stt-selftest-ok', 'ok');
  });

  it('run() rejects with the probe stderr when the self-test fails (no sentinel written)', async () => {
    const { spawn, children } = makeSpawn();
    const writeFile = vi.fn(async () => undefined);
    const svc = new SetupWizardService({
      ...opts,
      spawn,
      fs: { access: vi.fn(async () => undefined), writeFile },
    } as never);
    const promise = svc.run();
    setImmediate(() => children[0]!.emit('exit', 0));
    await new Promise((r) => setImmediate(r));
    setImmediate(() => children[1]!.emit('exit', 0));
    await new Promise((r) => setImmediate(r));
    setImmediate(() => {
      children[2]!.stderr.emit('data', Buffer.from('ImportError: DLL load failed: ctranslate2'));
      children[2]!.emit('exit', 1);
    });
    await expect(promise).rejects.toThrow(/DLL load failed: ctranslate2/);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("status() is 'pending' when the venv exists but the self-test sentinel does not", async () => {
    const access = vi.fn(async (p: string) => {
      if (p === '/data/sidecar-venv/.stt-selftest-ok') throw new Error('ENOENT');
    });
    const svc = new SetupWizardService({
      ...opts,
      spawn: vi.fn(),
      fs: { access, writeFile: vi.fn(async () => undefined) },
    } as never);
    expect(await svc.status()).toBe('pending');
  });

  it("status() is 'ready' when both the venv python and the sentinel exist", async () => {
    const svc = new SetupWizardService({
      ...opts,
      spawn: vi.fn(),
      fs: { access: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined) },
    } as never);
    expect(await svc.status()).toBe('ready');
  });
});
