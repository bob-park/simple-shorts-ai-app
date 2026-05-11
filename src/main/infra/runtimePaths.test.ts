import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveRuntimePaths } from './runtimePaths';

const MAC_PACKAGED_CTX = {
  isPackaged: true,
  resourcesPath: '/Applications/Shorts AI.app/Contents/Resources',
  userDataPath: '/Users/u/Library/Application Support/Shorts AI',
  repoRoot: '/unused-in-packaged',
  platform: 'darwin' as NodeJS.Platform,
  arch: 'arm64',
  fileExists: () => true,
};

const MAC_DEV_CTX = {
  isPackaged: false,
  resourcesPath: '/unused-in-dev',
  userDataPath: '/unused-in-dev',
  repoRoot: '/repo',
  platform: 'darwin' as NodeJS.Platform,
  arch: 'arm64',
  fileExists: (p: string) => p === '/repo/build-resources/mac-arm64/ffmpeg',
};

describe('resolveRuntimePaths', () => {
  it('macOS packaged: resolves all binaries inside resourcesPath without .exe', () => {
    const r = resolveRuntimePaths(MAC_PACKAGED_CTX);
    expect(r.uvBinary).toBe(join(MAC_PACKAGED_CTX.resourcesPath, 'uv'));
    expect(r.pythonRuntime).toBe(join(MAC_PACKAGED_CTX.resourcesPath, 'python-runtime', 'bin', 'python3.11'));
    expect(r.ffmpegBinary).toBe(join(MAC_PACKAGED_CTX.resourcesPath, 'ffmpeg'));
    expect(r.ytdlpBinary).toBe(join(MAC_PACKAGED_CTX.resourcesPath, 'yt-dlp'));
    expect(r.venvPath).toBe(join(MAC_PACKAGED_CTX.userDataPath, 'sidecar-venv'));
    expect(r.sidecarSpawn.command).toBe(join(MAC_PACKAGED_CTX.userDataPath, 'sidecar-venv', 'bin', 'python'));
    expect(r.sidecarSpawn.args).toEqual(['-m', 'shorts_sidecar']);
    expect(r.sidecarEnv).toEqual({ PYTHONPATH: join(MAC_PACKAGED_CTX.resourcesPath, 'sidecar-src') });
  });

  it('macOS dev with bundled ffmpeg present: ffmpegBinary points at build-resources/mac-arm64/ffmpeg', () => {
    const r = resolveRuntimePaths(MAC_DEV_CTX);
    expect(r.ffmpegBinary).toBe('/repo/build-resources/mac-arm64/ffmpeg');
    expect(r.uvBinary).toBe('uv');
    expect(r.pythonRuntime).toBe('python3.11');
    expect(r.ytdlpBinary).toBe('');
    expect(r.venvPath).toBe('/repo/sidecar/.venv');
    expect(r.requirementsPath).toBe('/repo/sidecar/requirements.txt');
    expect(r.sidecarCwd).toBe('/repo/sidecar');
    expect(r.sidecarSpawn.command).toBe('uv');
    expect(r.sidecarSpawn.args).toEqual(['run', 'python', '-m', 'shorts_sidecar']);
  });

  it('macOS dev without bundled ffmpeg: ffmpegBinary falls back to PATH name "ffmpeg"', () => {
    const r = resolveRuntimePaths({ ...MAC_DEV_CTX, fileExists: () => false });
    expect(r.ffmpegBinary).toBe('ffmpeg');
  });
});
