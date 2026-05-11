import type { SetupProgress, SetupStatus } from '@shared/setup';
import type { ChildProcess } from 'node:child_process';

interface FsLike {
  access: (path: string) => Promise<void>;
}

type SpawnLike = (command: string, args: readonly string[], options?: Record<string, unknown>) => ChildProcess;

export interface SetupWizardOptions {
  uvBinary: string;
  pythonRuntime: string;
  venvPath: string;
  /**
   * Path to the venv's python interpreter — `<venvPath>/bin/python` on mac
   * and Linux, `<venvPath>\Scripts\python.exe` on Windows. The wizard probes
   * this path to detect a ready venv and passes it as `uv pip install
   * --python`. Hardcoding `${venvPath}/bin/python` would break Windows.
   */
  venvPythonBinary: string;
  requirementsPath: string;
  spawn: SpawnLike;
  fs: FsLike;
}

type ProgressHandler = (p: SetupProgress) => void;

const RESOLVED_RE = /^Resolved (\d+) packages?/;
const INSTALLED_RE = /^Installed ([^\s]+)/;

/**
 * Orchestrates first-run sidecar setup: `uv venv` then `uv pip install -r`.
 * Streams progress to subscribed handlers by parsing pip stdout.
 */
export class SetupWizardService {
  private handlers: ProgressHandler[] = [];

  constructor(private readonly opts: SetupWizardOptions) {}

  async status(): Promise<SetupStatus> {
    try {
      await this.opts.fs.access(this.opts.venvPythonBinary);
      return 'ready';
    } catch {
      return 'pending';
    }
  }

  onProgress(h: ProgressHandler): () => void {
    this.handlers.push(h);
    return () => {
      this.handlers = this.handlers.filter((x) => x !== h);
    };
  }

  async run(): Promise<void> {
    await this.spawnAndWait(
      this.opts.uvBinary,
      ['venv', this.opts.venvPath, '--python', this.opts.pythonRuntime],
      'venv',
    );
    this.emit({ phase: 'venv', pct: 1 });
    await this.spawnAndWait(
      this.opts.uvBinary,
      ['pip', 'install', '--python', this.opts.venvPythonBinary, '-r', this.opts.requirementsPath],
      'pip',
    );
  }

  private spawnAndWait(cmd: string, args: string[], phase: 'venv' | 'pip'): Promise<void> {
    return new Promise((resolveP, rejectP) => {
      const child = this.opts.spawn(cmd, args, {});
      let stderrTail = '';
      let total = 0;
      let installed = 0;
      const onStdout = (chunk: Buffer | string) => {
        if (phase !== 'pip') return;
        const text = chunk.toString();
        for (const line of text.split('\n')) {
          const r = RESOLVED_RE.exec(line);
          if (r) {
            total = Number(r[1]);
            this.emit({ phase: 'pip', pct: 0, current: 0, total });
            continue;
          }
          const i = INSTALLED_RE.exec(line);
          if (i) {
            installed += 1;
            this.emit({
              phase: 'pip',
              pct: total > 0 ? installed / total : 0,
              current: installed,
              total,
              currentPackage: i[1],
            });
          }
        }
      };
      const onStderr = (chunk: Buffer | string) => {
        const text = chunk.toString();
        stderrTail = (stderrTail + text).slice(-1024);
      };
      child.stdout?.on('data', onStdout);
      child.stderr?.on('data', onStderr);
      child.on('error', rejectP);
      child.on('exit', (code) => {
        if (code === 0) resolveP();
        else rejectP(new Error(`${cmd} exited ${code}: ${stderrTail.trim() || '(no stderr)'}`));
      });
    });
  }

  private emit(p: SetupProgress): void {
    for (const h of this.handlers) h(p);
  }
}
