#!/usr/bin/env tsx
/**
 * Pre-package script: downloads python-build-standalone, uv, ffmpeg, and yt-dlp
 * for macOS arm64 (and in future, win-x64), verifies SHA-256, and unpacks into
 * build-resources/<target>/<tool>/ for electron-builder to pick up.
 *
 * Cached under build-resources/.cache/ — re-runs reuse cached archives
 * if SHA matches. Run via `yarn package` (which calls `prepackage`).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const CACHE_DIR = join(ROOT, 'build-resources', '.cache');
const OUT_DIR = join(ROOT, 'build-resources');

type Target = 'mac-arm64' | 'win-x64';

interface ArchEntry {
  url: string;
  sha256: string;
}

interface Tool {
  version: string;
  release?: string;            // python-only; ignored elsewhere
  targets: Partial<Record<Target, ArchEntry>>;
}

const KNOWN_TARGETS: readonly Target[] = ['mac-arm64', 'win-x64'];

export function parseTargetsArg(
  argv: string[],
  platform: NodeJS.Platform,
  arch: string,
): Target[] {
  const flag = argv.find((a) => a.startsWith('--target='));
  if (flag) {
    const raw = flag.slice('--target='.length).split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    for (const t of raw) {
      if (!KNOWN_TARGETS.includes(t as Target)) {
        throw new Error(`unknown target: ${t} (known: ${KNOWN_TARGETS.join(', ')})`);
      }
    }
    return raw as Target[];
  }
  // No --target: auto-detect from host. Only darwin-arm64 currently has
  // a 1:1 mapping. Anything else (win-x64 build, linux dev) must pass
  // --target explicitly.
  if (platform === 'darwin' && arch === 'arm64') return ['mac-arm64'];
  throw new Error(`No --target= given and host platform/arch (${platform}/${arch}) is not auto-mappable`);
}

const VERSIONS = JSON.parse(await readFile(join(ROOT, 'scripts', 'runtime-versions.json'), 'utf8')) as {
  python: Tool;
  uv: Tool;
  ffmpeg: Tool;
  ytdlp: Tool;
};

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function download(url: string, dest: string): Promise<void> {
  const tmpPath = `${dest}.partial`;
  console.log(`  ↓ ${url}`);
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status} for ${url}`);
  await mkdir(dirname(dest), { recursive: true });
  await pipeline(resp.body as unknown as NodeJS.ReadableStream, createWriteStream(tmpPath));
  await rename(tmpPath, dest);
}

async function ensureCached(url: string, expectedSha: string, filename: string): Promise<string> {
  const cached = join(CACHE_DIR, filename);
  if (existsSync(cached)) {
    const got = await sha256(cached);
    if (got === expectedSha) {
      console.log(`  ✓ cached ${filename}`);
      return cached;
    }
    console.log(`  ! SHA mismatch on cached ${filename} — redownloading`);
    rmSync(cached);
  }
  await download(url, cached);
  const got = await sha256(cached);
  if (got !== expectedSha) {
    throw new Error(`SHA-256 mismatch for ${filename}: expected ${expectedSha}, got ${got}`);
  }
  return cached;
}

async function spawn2(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolveP() : rejectP(new Error(`${cmd} exited ${code}`))));
    child.on('error', rejectP);
  });
}

async function unpackPython(archivePath: string, destDir: string): Promise<void> {
  if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  // python-build-standalone tarballs unpack to ./python/, we want destDir to BE the python dir
  await spawn2('tar', ['-xzf', archivePath, '-C', destDir, '--strip-components=1']);
}

async function unpackUv(archivePath: string, destFile: string, target: Target): Promise<void> {
  // mac-arm64 only for now; Task 5 will branch on file extension to handle the windows zip.
  if (existsSync(destFile)) rmSync(destFile);
  await mkdir(dirname(destFile), { recursive: true });
  const extractDir = join(CACHE_DIR, `uv-extract-${target}`);
  if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  await spawn2('tar', ['-xzf', archivePath, '-C', extractDir]);
  const archDirName = 'uv-aarch64-apple-darwin';  // mac-arm64 only; widened in Task 5
  await spawn2('cp', [join(extractDir, archDirName, 'uv'), destFile]);
  await spawn2('chmod', ['+x', destFile]);
}

async function installYtdlp(srcPath: string, destFile: string): Promise<void> {
  // yt-dlp_macos is a single self-contained binary (universal2). No unpack —
  // copy directly and chmod +x.
  if (existsSync(destFile)) rmSync(destFile);
  await mkdir(dirname(destFile), { recursive: true });
  await spawn2('cp', [srcPath, destFile]);
  await spawn2('chmod', ['+x', destFile]);
}

async function unpackFfmpeg(archivePath: string, destFile: string, target: Target): Promise<void> {
  // Same: mac-only for now; Task 5 widens. unzip the osxexperts.net archive
  // and copy the single 'ffmpeg' binary at root.
  if (existsSync(destFile)) rmSync(destFile);
  await mkdir(dirname(destFile), { recursive: true });
  const extractDir = join(CACHE_DIR, `ffmpeg-extract-${target}`);
  if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  await spawn2('unzip', ['-q', '-o', archivePath, '-d', extractDir]);
  // osxexperts.net zips contain a single `ffmpeg` binary at the root
  await spawn2('cp', [join(extractDir, 'ffmpeg'), destFile]);
  await spawn2('chmod', ['+x', destFile]);
}

async function fetchTarget(target: Target): Promise<void> {
  console.log(`\n=== ${target} ===`);
  const archDir = join(OUT_DIR, target);

  const pyMeta = VERSIONS.python.targets[target];
  if (!pyMeta) throw new Error(`No python entry for target ${target}`);
  const pyArchive = await ensureCached(pyMeta.url, pyMeta.sha256, `python-${VERSIONS.python.version}-${target}.tar.gz`);
  await unpackPython(pyArchive, join(archDir, 'python-runtime'));

  const uvMeta = VERSIONS.uv.targets[target];
  if (!uvMeta) throw new Error(`No uv entry for target ${target}`);
  const uvArchive = await ensureCached(uvMeta.url, uvMeta.sha256, `uv-${VERSIONS.uv.version}-${target}.tar.gz`);
  await unpackUv(uvArchive, join(archDir, 'uv'), target);

  const ffMeta = VERSIONS.ffmpeg.targets[target];
  if (!ffMeta) throw new Error(`No ffmpeg entry for target ${target}`);
  const ffArchive = await ensureCached(ffMeta.url, ffMeta.sha256, `ffmpeg-${VERSIONS.ffmpeg.version}-${target}.zip`);
  await unpackFfmpeg(ffArchive, join(archDir, 'ffmpeg'), target);

  const ytdlpMeta = VERSIONS.ytdlp.targets[target];
  if (!ytdlpMeta) throw new Error(`No yt-dlp entry for target ${target}`);
  const ytdlpFile = await ensureCached(ytdlpMeta.url, ytdlpMeta.sha256, `yt-dlp-${VERSIONS.ytdlp.version}-${target}`);
  await installYtdlp(ytdlpFile, join(archDir, 'yt-dlp'));

  console.log(`  ✓ ${target} ready at ${archDir}`);
}

async function main(): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const targets = parseTargetsArg(process.argv, process.platform, process.arch);
  for (const t of targets) await fetchTarget(t);
  console.log('\nAll runtime artifacts ready under build-resources/');
}

// Only run main() when this file is executed directly (CLI), not when
// imported by tests. Mirrors Python's `if __name__ == '__main__'`.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main().catch((e) => {
    console.error('fetch-runtime failed:', e);
    process.exit(1);
  });
}
