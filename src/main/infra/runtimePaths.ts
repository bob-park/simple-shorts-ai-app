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
  if (ctx.isPackaged) {
    const r = ctx.resourcesPath;
    const venvPath = join(ctx.userDataPath, 'sidecar-venv');
    return {
      uvBinary: join(r, 'uv'),
      pythonRuntime: join(r, 'python-runtime', 'bin', 'python3.11'),
      venvPath,
      requirementsPath: join(r, 'requirements.txt'),
      ffmpegBinary: join(r, 'ffmpeg'),
      ytdlpBinary: join(r, 'yt-dlp'),
      sidecarCwd: r,
      sidecarSpawn: {
        command: join(venvPath, 'bin', 'python'),
        args: ['-m', 'shorts_sidecar'],
      },
      sidecarEnv: { PYTHONPATH: join(r, 'sidecar-src') },
    };
  }
  // Dev mode — same logic as before, but build-resources path is now
  // <platform>-<arch>-keyed (mac-arm64) instead of <arch> alone (arm64).
  // See electron-builder.yml extraResources for the matching pattern.
  const targetDir = `${ctx.platform === 'win32' ? 'win' : 'mac'}-${ctx.arch}`;
  const bundledFfmpeg = join(ctx.repoRoot, 'build-resources', targetDir, 'ffmpeg');
  const ffmpegBinary = ctx.fileExists(bundledFfmpeg) ? bundledFfmpeg : 'ffmpeg';
  return {
    uvBinary: 'uv',
    pythonRuntime: 'python3.11',
    venvPath: join(ctx.repoRoot, 'sidecar', '.venv'),
    requirementsPath: join(ctx.repoRoot, 'sidecar', 'requirements.txt'),
    ffmpegBinary,
    ytdlpBinary: '',
    sidecarCwd: join(ctx.repoRoot, 'sidecar'),
    sidecarSpawn: { command: 'uv', args: ['run', 'python', '-m', 'shorts_sidecar'] },
    sidecarEnv: {},
  };
}
