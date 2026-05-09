import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PythonSidecar } from './PythonSidecar';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;
  kill(signal?: string): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit('exit', signal === 'SIGTERM' ? null : 0));
    return true;
  }
}

describe('PythonSidecar', () => {
  let spawn: ReturnType<typeof vi.fn>;
  let child: FakeChild;
  let sidecar: PythonSidecar;

  beforeEach(() => {
    child = new FakeChild();
    spawn = vi.fn(() => child);
    sidecar = new PythonSidecar({
      spawn: spawn as never,
      command: 'uv',
      args: ['run', 'python', '-m', 'shorts_sidecar'],
      cwd: '/tmp/sidecar',
      env: { HF_HOME: '/tmp/models' },
    });
  });

  afterEach(() => {
    sidecar.shutdown();
  });

  it('does not spawn until the first request', () => {
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns with configured command, args, cwd, and env on first request', async () => {
    const req = sidecar.request<{ ok: boolean }>('health');
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawn.mock.calls[0]!;
    expect(cmd).toBe('uv');
    expect(args).toEqual(['run', 'python', '-m', 'shorts_sidecar']);
    expect(opts.cwd).toBe('/tmp/sidecar');
    expect(opts.env).toMatchObject({ HF_HOME: '/tmp/models' });
    // Drive the response so the test can complete
    const sent = (child.stdin as PassThrough).read()?.toString() ?? '';
    const id = JSON.parse(sent.trim()).id;
    child.stdout.write(JSON.stringify({ id, result: { ok: true } }) + '\n');
    await expect(req).resolves.toEqual({ ok: true });
  });

  it('correlates concurrent requests by id', async () => {
    const a = sidecar.request<string>('health');
    const b = sidecar.request<string>('health');
    // Two writes → two ids
    const written = (child.stdin as PassThrough).read()!.toString().trim().split('\n');
    const idA = JSON.parse(written[0]!).id;
    const idB = JSON.parse(written[1]!).id;
    expect(idA).not.toEqual(idB);
    // Reply out of order
    child.stdout.write(JSON.stringify({ id: idB, result: 'B' }) + '\n');
    child.stdout.write(JSON.stringify({ id: idA, result: 'A' }) + '\n');
    await expect(a).resolves.toBe('A');
    await expect(b).resolves.toBe('B');
  });

  it('rejects when the response carries an error', async () => {
    const req = sidecar.request<unknown>('transcribe');
    const sent = (child.stdin as PassThrough).read()!.toString();
    const id = JSON.parse(sent.trim()).id;
    child.stdout.write(JSON.stringify({ id, error: { code: 'busy', message: 'try later' } }) + '\n');
    await expect(req).rejects.toMatchObject({ message: expect.stringContaining('busy') });
  });

  it('routes progress notifications to the subscriber', async () => {
    const events: unknown[] = [];
    sidecar.onProgress((p) => events.push(p));
    void sidecar.request<unknown>('transcribe', { audio_path: '/x' });
    (child.stdin as PassThrough).read(); // discard
    child.stdout.write(
      JSON.stringify({
        method: 'progress',
        params: { jobId: 'abc', processed: 1.5, total: 4.0 },
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual([{ jobId: 'abc', processed: 1.5, total: 4.0 }]);
  });

  it('handles the child exiting unexpectedly by failing in-flight requests and respawning on next call', async () => {
    const a = sidecar.request<unknown>('health');
    (child.stdin as PassThrough).read();
    child.emit('exit', 1);
    await expect(a).rejects.toThrow(/sidecar exited/i);

    // Next request must respawn
    const b = sidecar.request<unknown>('health');
    expect(spawn).toHaveBeenCalledTimes(2);
    void b.catch(() => undefined); // we don't drive a response, just confirm respawn
  });

  it('shutdown() sends EOF and waits for exit', async () => {
    sidecar.request<unknown>('health').catch(() => undefined);
    (child.stdin as PassThrough).read();
    sidecar.shutdown();
    // Either stdin was ended or the process killed — both observable
    await new Promise((r) => setTimeout(r, 0));
    expect(child.killed || (child.stdin as PassThrough).writableEnded).toBe(true);
  });
});
