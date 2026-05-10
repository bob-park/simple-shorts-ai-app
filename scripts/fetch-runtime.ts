#!/usr/bin/env tsx
/**
 * Pre-package script: downloads python-build-standalone, uv, and ffmpeg
 * for both arm64 and x64 macOS, verifies SHA-256, and unpacks into
 * build-resources/<arch>/<tool>/ for electron-builder to pick up.
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
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const CACHE_DIR = join(ROOT, 'build-resources', '.cache');
const OUT_DIR = join(ROOT, 'build-resources');
const VERSIONS = JSON.parse(await readFile(join(ROOT, 'scripts', 'runtime-versions.json'), 'utf8')) as {
  python: { version: string; release: string; arm64: ArchEntry; x64: ArchEntry };
  uv: { version: string; arm64: ArchEntry; x64: ArchEntry };
  ffmpeg: { version: string; arm64: ArchEntry; x64: ArchEntry };
  ytdlp: { version: string; arm64: ArchEntry; x64: ArchEntry };
};

interface ArchEntry {
  url: string;
  sha256: string;
}

type Arch = 'arm64' | 'x64';

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

async function unpackUv(archivePath: string, destFile: string, arch: Arch): Promise<void> {
  if (existsSync(destFile)) rmSync(destFile);
  await mkdir(dirname(destFile), { recursive: true });
  const extractDir = join(CACHE_DIR, `uv-extract-${arch}`);
  if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  await spawn2('tar', ['-xzf', archivePath, '-C', extractDir]);
  // uv tarball contains uv-<arch>-apple-darwin/uv
  const archDirName = arch === 'arm64' ? 'uv-aarch64-apple-darwin' : 'uv-x86_64-apple-darwin';
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

async function unpackFfmpeg(archivePath: string, destFile: string, arch: Arch): Promise<void> {
  if (existsSync(destFile)) rmSync(destFile);
  await mkdir(dirname(destFile), { recursive: true });
  const extractDir = join(CACHE_DIR, `ffmpeg-extract-${arch}`);
  if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  await spawn2('unzip', ['-q', '-o', archivePath, '-d', extractDir]);
  // osxexperts.net zips contain a single `ffmpeg` binary at the root
  await spawn2('cp', [join(extractDir, 'ffmpeg'), destFile]);
  await spawn2('chmod', ['+x', destFile]);
}

async function fetchArch(arch: Arch): Promise<void> {
  console.log(`\n=== ${arch} ===`);
  const archDir = join(OUT_DIR, arch);

  const pyMeta = VERSIONS.python[arch];
  const pyArchive = await ensureCached(pyMeta.url, pyMeta.sha256, `python-${VERSIONS.python.version}-${arch}.tar.gz`);
  await unpackPython(pyArchive, join(archDir, 'python-runtime'));

  const uvMeta = VERSIONS.uv[arch];
  const uvArchive = await ensureCached(uvMeta.url, uvMeta.sha256, `uv-${VERSIONS.uv.version}-${arch}.tar.gz`);
  await unpackUv(uvArchive, join(archDir, 'uv'), arch);

  const ffMeta = VERSIONS.ffmpeg[arch];
  const ffArchive = await ensureCached(ffMeta.url, ffMeta.sha256, `ffmpeg-${VERSIONS.ffmpeg.version}-${arch}.zip`);
  await unpackFfmpeg(ffArchive, join(archDir, 'ffmpeg'), arch);

  const ytdlpMeta = VERSIONS.ytdlp[arch];
  const ytdlpFile = await ensureCached(ytdlpMeta.url, ytdlpMeta.sha256, `yt-dlp-${VERSIONS.ytdlp.version}-${arch}`);
  await installYtdlp(ytdlpFile, join(archDir, 'yt-dlp'));

  console.log(`  ✓ ${arch} ready at ${archDir}`);
}

async function main(): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await fetchArch('arm64');
  await fetchArch('x64');
  console.log('\nAll runtime artifacts ready under build-resources/');
}

void main().catch((e) => {
  console.error('fetch-runtime failed:', e);
  process.exit(1);
});
