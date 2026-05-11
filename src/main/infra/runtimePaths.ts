import { join } from 'node:path';

export interface RuntimePaths {
  uvBinary: string;
  pythonRuntime: string;
  venvPath: string;
  requirementsPath: string;
  ffmpegBinary: string;
  /**
   * Standalone yt-dlp binary (PyInstaller single-file). Used instead of
   * youtube-dl-exec's bundled zipapp because the zipapp shells out to system
   * Python, and macOS's system Python (3.9 from CommandLineTools) is too old
   * for current yt-dlp (requires 3.10+). Empty string in dev mode (we fall
   * back to youtube-dl-exec's bundled zipapp via PATH python3).
   */
  ytdlpBinary: string;
  sidecarCwd: string;
  /**
   * Path to the venv's python interpreter — `<venv>/bin/python` on mac and
   * Linux, `<venv>\Scripts\python.exe` on Windows. Passed to uv as the
   * `--python` value when installing requirements into the venv, and used by
   * `SetupWizardService` to check whether the venv has been created.
   */
  venvPythonBinary: string;
  /**
   * Packaged: sidecar venv's python directly. Dev: `uv run python -m
   * shorts_sidecar` which auto-resolves the venv.
   */
  sidecarSpawn: { command: string; args: string[] };
  /** Extra env vars for the sidecar spawn (PYTHONPATH in packaged mode). */
  sidecarEnv: Record<string, string>;
}

export interface ResolveRuntimePathsContext {
  isPackaged: boolean;
  resourcesPath: string;
  userDataPath: string;
  repoRoot: string;
  platform: NodeJS.Platform;
  arch: string;
  fileExists: (path: string) => boolean;
}

export function resolveRuntimePaths(ctx: ResolveRuntimePathsContext): RuntimePaths {
  const isWin = ctx.platform === 'win32';
  const exe = isWin ? '.exe' : '';
  // uv-created venv layout differs by platform.
  const venvBin = isWin ? 'Scripts' : 'bin';
  // python-build-standalone places the interpreter at different paths:
  //   mac-arm64 : python-runtime/bin/python3.11
  //   win-x64   : python-runtime/python.exe
  const pythonInRuntime = isWin ? ['python.exe'] : ['bin', 'python3.11'];

  if (ctx.isPackaged) {
    const r = ctx.resourcesPath;
    const venvPath = join(ctx.userDataPath, 'sidecar-venv');
    const venvPythonBinary = join(venvPath, venvBin, `python${exe}`);
    return {
      uvBinary: join(r, `uv${exe}`),
      pythonRuntime: join(r, 'python-runtime', ...pythonInRuntime),
      venvPath,
      requirementsPath: join(r, 'requirements.txt'),
      ffmpegBinary: join(r, `ffmpeg${exe}`),
      ytdlpBinary: join(r, `yt-dlp${exe}`),
      sidecarCwd: r,
      venvPythonBinary,
      sidecarSpawn: { command: venvPythonBinary, args: ['-m', 'shorts_sidecar'] },
      // PYTHONUTF8 / PYTHONIOENCODING force the sidecar's stdin/stdout/stderr
      // to UTF-8 regardless of the OS locale. Without this, Python 3.11 on
      // Windows falls back to the system codepage (cp949 / cp1252) with
      // surrogateescape, which mangles non-ASCII filenames (Korean / Japanese
      // / accented Latin) coming through the JSON-RPC line we write from Node
      // — even though Node writes valid UTF-8 bytes. See PEP 540.
      sidecarEnv: {
        PYTHONPATH: join(r, 'sidecar-src'),
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
    };
  }

  // Dev mode — build-resources/<platform>-<arch>/.
  const targetDir = `${isWin ? 'win' : 'mac'}-${ctx.arch}`;
  const bundledFfmpeg = join(ctx.repoRoot, 'build-resources', targetDir, `ffmpeg${exe}`);
  const ffmpegBinary = ctx.fileExists(bundledFfmpeg) ? bundledFfmpeg : `ffmpeg${exe}`;
  const venvPath = join(ctx.repoRoot, 'sidecar', '.venv');
  return {
    uvBinary: 'uv',
    pythonRuntime: 'python3.11',
    venvPath,
    requirementsPath: join(ctx.repoRoot, 'sidecar', 'requirements.txt'),
    ffmpegBinary,
    ytdlpBinary: '',
    sidecarCwd: join(ctx.repoRoot, 'sidecar'),
    venvPythonBinary: join(venvPath, venvBin, `python${exe}`),
    sidecarSpawn: { command: 'uv', args: ['run', 'python', '-m', 'shorts_sidecar'] },
    // Same UTF-8 forcing as packaged mode — see comment above. macOS/Linux
    // dev shells almost always already resolve to UTF-8 so this is a no-op
    // there, but it makes Windows dev work the same as the packaged build
    // if anyone ever runs `yarn dev` on a Windows host.
    sidecarEnv: {
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    },
  };
}
