import type { SetupProgress, SetupStatus } from '@shared/setup';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';

interface FsLike {
  access: (path: string) => Promise<void>;
  writeFile: (path: string, data: string) => Promise<void>;
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
  /**
   * Additional package indexes passed to `uv pip install --extra-index-url`.
   * Caller-provided per platform — Windows wants the CUDA-enabled
   * llama-cpp-python build at https://abetlen.github.io/llama-cpp-python/whl/cu124
   * while macOS wants the CPU build at .../whl/cpu. We can't declare these
   * inside requirements.txt because uv doesn't honor env markers on the
   * `--extra-index-url` directive there.
   */
  extraIndexUrls?: readonly string[];
  /**
   * Optional PEP-508 spec written to a uv `--overrides` file so it FORCES a
   * package version regardless of the pin in requirements.txt (no resolution
   * conflict — that's what overrides are for). Used for the EXPERIMENTAL
   * NVIDIA path: requirements.txt pins the CPU-safe `llama-cpp-python==0.3.19`
   * (the Problem-A corrupt-wheel guard), but an NVIDIA box overrides it to
   * the CUDA `==0.3.23` from the cu124 index. Absent on the default path.
   */
  llamaCudaOverrideSpec?: string;
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

  private get sentinelPath(): string {
    return join(this.opts.venvPath, '.stt-selftest-ok');
  }

  /**
   * Imports the STT runtime (faster_whisper / ctranslate2 / av) in the venv
   * python to fail fast at setup time instead of mid-job. Called by `run()`
   * after pip install; `run()` (not this method) writes the success sentinel,
   * so calling `selfTest()` standalone never marks setup ready.
   */
  async selfTest(): Promise<void> {
    await this.spawnAndWait(
      this.opts.venvPythonBinary,
      ['-c', 'import faster_whisper, ctranslate2, av; print("stt-ok")'],
      'selftest',
    );
  }

  async status(): Promise<SetupStatus> {
    try {
      await this.opts.fs.access(this.opts.venvPythonBinary);
      await this.opts.fs.access(this.sentinelPath);
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
    const extraIndexArgs = (this.opts.extraIndexUrls ?? []).flatMap((url) => [
      '--extra-index-url',
      url,
    ]);
    // EXPERIMENTAL NVIDIA path: force the CUDA llama-cpp-python via a uv
    // --overrides file (venv exists now, post `uv venv`). No-op by default.
    let overrideArgs: string[] = [];
    if (this.opts.llamaCudaOverrideSpec) {
      const overridePath = join(this.opts.venvPath, '.llama-override.txt');
      await this.opts.fs.writeFile(overridePath, `${this.opts.llamaCudaOverrideSpec}\n`);
      overrideArgs = ['--overrides', overridePath];
    }
    await this.spawnAndWait(
      this.opts.uvBinary,
      [
        'pip',
        'install',
        ...extraIndexArgs,
        ...overrideArgs,
        '--python',
        this.opts.venvPythonBinary,
        '-r',
        this.opts.requirementsPath,
      ],
      'pip',
    );
    await this.selfTest();
    await this.opts.fs.writeFile(this.sentinelPath, 'ok');
  }

  private spawnAndWait(cmd: string, args: string[], phase: 'venv' | 'pip' | 'selftest'): Promise<void> {
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
