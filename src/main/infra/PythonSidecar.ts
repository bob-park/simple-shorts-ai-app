import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: Record<string, unknown>,
) => ChildProcessWithoutNullStreams;

export interface PythonSidecarOptions {
  spawn: SpawnLike;
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export interface ProgressMessage {
  jobId: string;
  processed: number;
  total: number;
}

type ProgressHandler = (p: ProgressMessage) => void;

/**
 * Spawns the Python sidecar lazily on first `request()`. Owns id-correlation
 * and progress dispatch. If the child exits, in-flight requests reject and
 * the next call respawns it.
 */
export class PythonSidecar {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private pending = new Map<string, PendingRequest>();
  private progressHandlers: ProgressHandler[] = [];

  constructor(private readonly opts: PythonSidecarOptions) {}

  onProgress(handler: ProgressHandler): () => void {
    this.progressHandlers.push(handler);
    return () => {
      this.progressHandlers = this.progressHandlers.filter((h) => h !== handler);
    };
  }

  request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const child = this.ensureSpawned();
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      child.stdin.write(JSON.stringify({ id, method, params: params ?? {} }) + '\n');
    });
  }

  /**
   * Sends a notification (no id, no response). Used for cancel which we treat
   * as fire-and-forget — the in-flight transcribe request rejects with a
   * 'canceled' error from the sidecar instead.
   */
  notify(method: string, params?: Record<string, unknown>): void {
    const child = this.ensureSpawned();
    child.stdin.write(JSON.stringify({ method, params: params ?? {} }) + '\n');
  }

  shutdown(): void {
    const child = this.child;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }
    if (!child.killed) {
      child.kill('SIGTERM');
    }
    this.child = null;
    this.failAllPending(new Error('sidecar shutting down'));
  }

  private ensureSpawned(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = this.opts.spawn(this.opts.command, this.opts.args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...(this.opts.env ?? {}) },
    });
    this.child = child;

    child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line) this.handleLine(line);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      // Forward sidecar logs to our stderr for diagnostics.
      process.stderr.write(`[sidecar] ${chunk}`);
    });

    child.on('exit', (code) => {
      this.child = null;
      const err = new Error(`sidecar exited with code ${code}`);
      this.failAllPending(err);
    });

    child.on('error', (err) => {
      this.child = null;
      this.failAllPending(err);
    });

    return child;
  }

  private handleLine(line: string): void {
    let msg: {
      id?: string;
      method?: string;
      result?: unknown;
      error?: { code?: string; message?: string };
      params?: ProgressMessage;
    };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method === 'progress' && msg.params) {
      for (const h of this.progressHandlers) h(msg.params);
      return;
    }
    if (typeof msg.id === 'string') {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const { code, message } = msg.error;
        const errMsg = code ? `${code}: ${message ?? 'sidecar error'}` : (message ?? 'sidecar error');
        pending.reject(new Error(errMsg));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private failAllPending(err: Error): void {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }
}
