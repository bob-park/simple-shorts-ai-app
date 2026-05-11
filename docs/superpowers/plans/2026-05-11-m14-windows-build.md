# Windows Build — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `yarn package:win` target that, run from a macOS host with `wine` installed, produces `out/Shorts AI Setup <version>.exe` — an NSIS installer for Windows 10/11 x64 — while keeping the existing `yarn package:mac` arm64 DMG pipeline working unchanged.

**Architecture:** Refactor `resolveRuntimePaths()` out of `main.ts` into a pure module that takes platform/arch/isPackaged inputs explicitly (testable in isolation). Migrate `runtime-versions.json` from per-tool `arm64/x64` keys to a `targets.<platform>-<arch>` map. Refactor `scripts/fetch-runtime.ts` to accept `--target=<key>` and dispatch unpack helpers by file extension. Parameterise `electron-builder.yml` `extraResources` with the built-in `${platform}-${arch}` / `${ext}` tokens so one block serves both targets. Split `package.json` into `package:mac` and `package:win` scripts; the win path also invokes `electron-rebuild --platform=win32 --arch=x64` so the bundled `better-sqlite3` native binary is a Windows PE file.

**Tech Stack:** electron-builder (NSIS target), `@electron/rebuild` (cross-platform native rebuild), `wine-stable` (macOS host requirement for NSIS makensis), python-build-standalone (Windows MSVC shared runtime), BtbN ffmpeg-win64-gpl (libass-enabled), yt-dlp.exe.

**Spec:** `docs/superpowers/specs/2026-05-11-windows-build-design.md`.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/main/infra/runtimePaths.ts` | Pure function that maps `{ isPackaged, platform, arch, resourcesPath, userDataPath, repoRoot, fileExists }` → concrete absolute paths for python, uv, ffmpeg, yt-dlp, venv, sidecar spawn. | **CREATE** |
| `src/main/infra/runtimePaths.test.ts` | Unit tests for the pure function across mac/win × packaged/dev. | **CREATE** |
| `src/main/main.ts` | Electron main process entry. | MODIFY: import `resolveRuntimePaths` from the new module; delete the inline definition; pass the context object at call sites. |
| `scripts/runtime-versions.json` | Pinned URLs + SHA-256s of runtime binaries to fetch. | MODIFY: flatten to `targets.<platform>-<arch>` schema; drop mac-x64; add win-x64 entries (python, uv, ffmpeg, yt-dlp). |
| `scripts/fetch-runtime.ts` | Pre-package script — downloads + unpacks runtime tools into `build-resources/<target>/`. | MODIFY: accept `--target=` CLI arg; reshape against new JSON schema; branch unpack helpers on file extension (.tar.gz vs .zip vs single binary); rename build-resources/<arch>/ → build-resources/<platform>-<arch>/. |
| `scripts/fetch-runtime.test.ts` | Tests for `parseTargetsArg()`. | **CREATE** |
| `electron-builder.yml` | Packaging config. | MODIFY: add `win` + `nsis` sections; rewrite `extraResources` with `${platform}-${arch}` / `${ext}` tokens. |
| `package.json` | Scripts. | MODIFY: split into `package:mac` / `package:win`; add `fetch-runtime:mac` / `fetch-runtime:win` / `rebuild:better-sqlite3:win`; keep `package` as `package:mac` alias; drop `prepackage` hook. |
| `docs/build-windows.md` | Developer guide for cross-building the Windows installer from macOS. | **CREATE** |

Files NOT touched: every test file other than the two new ones, every source file under `src/main/services/`, `src/renderer/`, `src/shared/`, `sidecar/`. The Windows build is a packaging-layer change only.

---

### Task 1: Extract `resolveRuntimePaths` into a pure module (refactor, no behavior change)

**Files:**
- Create: `src/main/infra/runtimePaths.ts`
- Create: `src/main/infra/runtimePaths.test.ts`
- Modify: `src/main/main.ts`

This task is pure refactor. mac packaged + mac dev behavior must be byte-identical after. We extract first so subsequent tasks (Windows branch, build-resources rename) have a testable seam.

- [ ] **Step 1: Write the failing test file**

Create `src/main/infra/runtimePaths.test.ts` with exact contents:

```ts
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
```

- [ ] **Step 2: Run the test and verify it fails on import**

Run: `yarn test src/main/infra/runtimePaths.test.ts`
Expected: FAIL with "Cannot find module './runtimePaths'" (or vitest's equivalent module-not-found message).

- [ ] **Step 3: Create the extracted module**

Create `src/main/infra/runtimePaths.ts` with exact contents:

```ts
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
  const targetDir = `mac-${ctx.arch}`;
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
```

Note: this module already adopts the renamed `build-resources/mac-arm64/` path (was `build-resources/arm64/`). The matching electron-builder.yml change is in Task 6; the fetch-runtime.ts rename is in Task 4. Between now and Task 4 the dev-mode bundled-ffmpeg fallback will miss until the user re-runs the fetcher — that's the trade-off for keeping the rename in one place.

- [ ] **Step 4: Run the test and verify it passes**

Run: `yarn test src/main/infra/runtimePaths.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Replace inline `resolveRuntimePaths` in `main.ts`**

Open `src/main/main.ts`. Delete lines 32-104 (the `RuntimePaths` interface and the inline `resolveRuntimePaths` function — currently around `interface RuntimePaths { uvBinary: string; ... } ... function resolveRuntimePaths(): RuntimePaths { ... }`).

Add this import at the top (next to the other relative-path imports — search for `from './infra/`):

```ts
import { resolveRuntimePaths as resolveRuntimePathsImpl, type RuntimePaths } from './infra/runtimePaths';
```

Add this wrapper just below the deleted block (replacing the old function position so callers don't move):

```ts
function resolveRuntimePaths(): RuntimePaths {
  return resolveRuntimePathsImpl({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath('userData'),
    repoRoot: resolvePath(__dirname, '../../'),
    platform: process.platform,
    arch: process.arch,
    fileExists: existsSync,
  });
}
```

The four existing call sites (`resolveRuntimePaths()` in the spawn helpers and the `getRenderService` / `getHistoryService` setup) need no edits — they already call `resolveRuntimePaths()` with no args.

- [ ] **Step 6: Run typecheck + full test suite to confirm no regressions**

Run: `yarn typecheck`
Expected: EXIT=0.

Run: `yarn test`
Expected: All previously-passing tests still pass; new `runtimePaths.test.ts` tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/main/infra/runtimePaths.ts src/main/infra/runtimePaths.test.ts src/main/main.ts
git commit -m "$(cat <<'EOF'
refactor(main): extract resolveRuntimePaths into pure module with tests

Move the runtime-path resolver out of main.ts into src/main/infra/runtimePaths.ts
as a pure function that takes platform/arch/isPackaged inputs explicitly. This
gives us a testable seam for the upcoming Windows branch and locks down the
existing mac packaged + dev behavior with unit tests. Also adopts the new
build-resources/mac-arm64/ path convention; the matching fetcher + builder
config changes follow in later tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Flatten `runtime-versions.json` to `targets.<key>` schema (mac-arm64 only)

**Files:**
- Modify: `scripts/runtime-versions.json`
- Modify: `scripts/fetch-runtime.ts`

Reshape the JSON so future tasks just add `win-x64` entries. No URL changes yet, no Windows entries yet, no `--target` arg yet.

- [ ] **Step 1: Rewrite `scripts/runtime-versions.json`**

Replace the entire file with:

```json
{
  "python": {
    "version": "3.11.10",
    "release": "20241016",
    "targets": {
      "mac-arm64": {
        "url": "https://github.com/astral-sh/python-build-standalone/releases/download/20241016/cpython-3.11.10+20241016-aarch64-apple-darwin-install_only.tar.gz",
        "sha256": "5a69382da99c4620690643517ca1f1f53772331b347e75f536088c42a4cf6620"
      }
    }
  },
  "uv": {
    "version": "0.5.6",
    "targets": {
      "mac-arm64": {
        "url": "https://github.com/astral-sh/uv/releases/download/0.5.6/uv-aarch64-apple-darwin.tar.gz",
        "sha256": "dc122e0c41f7a3fbc8004802062785e6b5c8171bc2a2ca0adc5485165c92452d"
      }
    }
  },
  "ffmpeg": {
    "version": "7.1",
    "targets": {
      "mac-arm64": {
        "url": "https://www.osxexperts.net/ffmpeg71arm.zip",
        "sha256": "0878f3313311c2c1b2c818e7c955c0bd828c97b357fa86211b42a5c36d01e36f"
      }
    }
  },
  "ytdlp": {
    "version": "2026.03.17",
    "targets": {
      "mac-arm64": {
        "url": "https://github.com/yt-dlp/yt-dlp/releases/download/2026.03.17/yt-dlp_macos",
        "sha256": "e80c47b3ce712acee51d5e3d4eace2d181b44d38f1942c3a32e3c7ff53cd9ed5"
      }
    }
  }
}
```

The mac-x64 entries are dropped (they were already disabled in the fetcher; not in scope).

- [ ] **Step 2: Update the `VERSIONS` type + per-tool reads in `scripts/fetch-runtime.ts`**

Open `scripts/fetch-runtime.ts`. Replace the `VERSIONS = JSON.parse(...)` type annotation (currently around lines 22-27) with:

```ts
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

const VERSIONS = JSON.parse(await readFile(join(ROOT, 'scripts', 'runtime-versions.json'), 'utf8')) as {
  python: Tool;
  uv: Tool;
  ffmpeg: Tool;
  ytdlp: Tool;
};
```

The old `Arch = 'arm64' | 'x64'` type alias and the `python.arm64` / `python.x64` shaped destructuring all disappear; they're replaced in the next step.

- [ ] **Step 3: Replace `fetchArch(arch)` with a target-keyed version**

Still in `scripts/fetch-runtime.ts`. Delete the existing `fetchArch(arch: Arch)` function (currently around lines 120-141) and replace with:

```ts
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
```

Note the changed `Arch` → `Target` parameter type on `unpackUv` and `unpackFfmpeg` — those helpers need their signatures updated correspondingly. Find each existing definition (currently around lines 86-97 and 108-118) and change the parameter type:

```ts
async function unpackUv(archivePath: string, destFile: string, target: Target): Promise<void> {
  // ... body unchanged for now (still uses the mac-arm64 'uv-aarch64-apple-darwin' folder name);
  // Task 5 will branch this on file extension to handle the windows zip.
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

async function unpackFfmpeg(archivePath: string, destFile: string, target: Target): Promise<void> {
  // Same: mac-only for now; Task 5 widens. unzip the osxexperts.net archive
  // and copy the single 'ffmpeg' binary at root.
  if (existsSync(destFile)) rmSync(destFile);
  await mkdir(dirname(destFile), { recursive: true });
  const extractDir = join(CACHE_DIR, `ffmpeg-extract-${target}`);
  if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  await spawn2('unzip', ['-q', '-o', archivePath, '-d', extractDir]);
  await spawn2('cp', [join(extractDir, 'ffmpeg'), destFile]);
  await spawn2('chmod', ['+x', destFile]);
}
```

Finally, update `main()` (currently around lines 143-149) to:

```ts
async function main(): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await fetchTarget('mac-arm64');  // Task 3 generalises this via --target
  console.log('\nAll runtime artifacts ready under build-resources/');
}
```

The `Arch` type and `fetchArch` are now fully removed.

- [ ] **Step 4: Rename the existing dev-mode bundle directory and re-fetch**

This is a one-time disk operation so the new `mac-${arch}` path in runtimePaths.ts (Task 1) and electron-builder.yml (Task 6) resolves:

```bash
mv build-resources/arm64 build-resources/mac-arm64 2>/dev/null || true
```

Then run the updated fetcher to confirm it still works against the new schema:

```bash
yarn tsx scripts/fetch-runtime.ts
```

Expected output ends with `✓ mac-arm64 ready at .../build-resources/mac-arm64` and no SHA mismatch errors.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

Run: `yarn test`
Expected: All tests pass, including the new `runtimePaths.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add scripts/runtime-versions.json scripts/fetch-runtime.ts
git commit -m "$(cat <<'EOF'
refactor(build): flatten runtime-versions.json to targets.<platform-arch>

Reshape the JSON from per-tool {arm64, x64} keys to per-tool {targets: {
  "mac-arm64": {url, sha256} }}, drop the disabled mac-x64 entries, and
update fetch-runtime.ts to consume the new schema. Cache filenames now
include the target (e.g. ffmpeg-7.1-mac-arm64.zip) so future win-x64
entries don't collide. The build-resources/<arch>/ directory is renamed
to build-resources/<platform>-<arch>/ — gitignored, so this is a runtime
rename only; the fetcher writes to the new path on next invocation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Add `--target=` CLI argument to the fetcher (TDD on parseTargetsArg)

**Files:**
- Create: `scripts/fetch-runtime.test.ts`
- Modify: `scripts/fetch-runtime.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/fetch-runtime.test.ts` with exact contents:

```ts
import { describe, expect, it } from 'vitest';

import { parseTargetsArg } from './fetch-runtime';

describe('parseTargetsArg', () => {
  it('returns the single target from --target=win-x64', () => {
    expect(parseTargetsArg(['node', 'fetch-runtime.ts', '--target=win-x64'], 'darwin', 'arm64')).toEqual([
      'win-x64',
    ]);
  });

  it('splits a comma-separated --target list in order', () => {
    expect(
      parseTargetsArg(['node', 'fetch-runtime.ts', '--target=mac-arm64,win-x64'], 'darwin', 'arm64'),
    ).toEqual(['mac-arm64', 'win-x64']);
  });

  it('defaults to mac-arm64 when host is darwin-arm64 and no --target given', () => {
    expect(parseTargetsArg(['node', 'fetch-runtime.ts'], 'darwin', 'arm64')).toEqual(['mac-arm64']);
  });

  it('throws when host is not auto-mappable and no --target given', () => {
    expect(() => parseTargetsArg(['node', 'fetch-runtime.ts'], 'linux', 'x64')).toThrow(/--target/);
  });

  it('throws on an unknown target', () => {
    expect(() =>
      parseTargetsArg(['node', 'fetch-runtime.ts', '--target=lin-x64'], 'darwin', 'arm64'),
    ).toThrow(/unknown target/i);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `yarn test scripts/fetch-runtime.test.ts`
Expected: FAIL with "Cannot find module './fetch-runtime'" OR "parseTargetsArg is not exported" — either way, missing-export error.

- [ ] **Step 3: Gate top-level `main()` and add `parseTargetsArg`**

Open `scripts/fetch-runtime.ts`. At the very bottom, the file currently has:

```ts
void main().catch((e) => {
  console.error('fetch-runtime failed:', e);
  process.exit(1);
});
```

Replace with:

```ts
// Only run main() when this file is executed directly (CLI), not when
// imported by tests. Mirrors Python's `if __name__ == '__main__'`.
import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main().catch((e) => {
    console.error('fetch-runtime failed:', e);
    process.exit(1);
  });
}
```

(Add the `pathToFileURL` import alongside the existing `fileURLToPath` import at the top: `import { fileURLToPath, pathToFileURL } from 'node:url';`.)

Then add a new exported function near the other top-level helpers (just below the `Target` type and `Tool` interface from Task 2):

```ts
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
```

Update `main()` to use it:

```ts
async function main(): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const targets = parseTargetsArg(process.argv, process.platform, process.arch);
  for (const t of targets) await fetchTarget(t);
  console.log('\nAll runtime artifacts ready under build-resources/');
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `yarn test scripts/fetch-runtime.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Smoke-test the CLI from a shell**

Run: `yarn tsx scripts/fetch-runtime.ts --target=mac-arm64`
Expected: prints `=== mac-arm64 ===` and `✓ mac-arm64 ready at ...`. (Will use cached archives — no fresh download required.)

Run: `yarn tsx scripts/fetch-runtime.ts --target=lin-x64`
Expected: FAILS with `unknown target: lin-x64` on stderr; exit code 1.

- [ ] **Step 6: Commit**

```bash
git add scripts/fetch-runtime.ts scripts/fetch-runtime.test.ts
git commit -m "$(cat <<'EOF'
feat(build): add --target= CLI argument to fetch-runtime.ts

parseTargetsArg() (exported, unit-tested) parses --target=mac-arm64,win-x64
or auto-detects mac-arm64 from the host. main() is gated behind an
import.meta.url check so tests can import the function without triggering
a download. The two-target list infrastructure is in place; the actual
win-x64 fetch URLs land in the next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Add `win-x64` entries to runtime-versions.json and extend unpack helpers

**Files:**
- Modify: `scripts/runtime-versions.json`
- Modify: `scripts/fetch-runtime.ts`

This task brings the binaries the Windows installer needs. The SHA-256 values are recorded in two phases: a) the contributor downloads each URL once and `shasum -a 256`s it; b) the value is committed. The plan can't pre-fill them.

- [ ] **Step 1: Add win-x64 entries with placeholder SHAs**

Edit `scripts/runtime-versions.json`. After each existing `"mac-arm64": { ... }` entry, add a sibling `"win-x64"` entry with the URL pinned and SHA set to a sentinel:

```json
{
  "python": {
    "version": "3.11.10",
    "release": "20241016",
    "targets": {
      "mac-arm64": { ... unchanged ... },
      "win-x64": {
        "url": "https://github.com/astral-sh/python-build-standalone/releases/download/20241016/cpython-3.11.10+20241016-x86_64-pc-windows-msvc-shared-install_only.tar.gz",
        "sha256": "FILL_IN_AT_FETCH"
      }
    }
  },
  "uv": {
    "version": "0.5.6",
    "targets": {
      "mac-arm64": { ... unchanged ... },
      "win-x64": {
        "url": "https://github.com/astral-sh/uv/releases/download/0.5.6/uv-x86_64-pc-windows-msvc.zip",
        "sha256": "FILL_IN_AT_FETCH"
      }
    }
  },
  "ffmpeg": {
    "version": "7.1",
    "targets": {
      "mac-arm64": { ... unchanged ... },
      "win-x64": {
        "url": "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2024-10-08-13-04/ffmpeg-n7.1-latest-win64-gpl-7.1.zip",
        "sha256": "FILL_IN_AT_FETCH"
      }
    }
  },
  "ytdlp": {
    "version": "2026.03.17",
    "targets": {
      "mac-arm64": { ... unchanged ... },
      "win-x64": {
        "url": "https://github.com/yt-dlp/yt-dlp/releases/download/2026.03.17/yt-dlp.exe",
        "sha256": "FILL_IN_AT_FETCH"
      }
    }
  }
}
```

Notes on URL choices:
- **python**: `pc-windows-msvc-shared` (not `pc-windows-msvc-static`) — the shared variant ships `python311.dll`, which uv-created venvs need at runtime.
- **ffmpeg**: BtbN `autobuild-2024-10-08-13-04` tag is the latest stable n7.1 win64-gpl build with libass enabled at the time of writing. If that exact tag is no longer downloadable when this task runs, pick the newest `autobuild-YYYY-MM-DD-HH-mm` win64-gpl release at that moment and update both the URL and the cache filename. Confirm libass support with `unzip -p <file>.zip <inner>/bin/ffmpeg.exe | grep -ao 'enable-libass'` before pinning.
- **yt-dlp**: the same `2026.03.17` release shipped a Windows .exe alongside the macOS binary. The version matches mac so the in-app yt-dlp behavior stays in lockstep.

- [ ] **Step 2: Compute real SHA-256s for each URL and replace the sentinels**

For each of the four `"sha256": "FILL_IN_AT_FETCH"` lines:

```bash
curl -L -o /tmp/win-python.tar.gz "https://github.com/astral-sh/python-build-standalone/releases/download/20241016/cpython-3.11.10+20241016-x86_64-pc-windows-msvc-shared-install_only.tar.gz"
shasum -a 256 /tmp/win-python.tar.gz
# Paste the hex digest into runtime-versions.json under python.targets.win-x64.sha256

curl -L -o /tmp/win-uv.zip "https://github.com/astral-sh/uv/releases/download/0.5.6/uv-x86_64-pc-windows-msvc.zip"
shasum -a 256 /tmp/win-uv.zip

curl -L -o /tmp/win-ffmpeg.zip "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2024-10-08-13-04/ffmpeg-n7.1-latest-win64-gpl-7.1.zip"
shasum -a 256 /tmp/win-ffmpeg.zip

curl -L -o /tmp/win-ytdlp.exe "https://github.com/yt-dlp/yt-dlp/releases/download/2026.03.17/yt-dlp.exe"
shasum -a 256 /tmp/win-ytdlp.exe
```

Paste each `<sha-hex>  /tmp/...` first column into the corresponding entry. Verify all four sentinels are gone (`grep FILL_IN_AT_FETCH scripts/runtime-versions.json` returns no matches).

- [ ] **Step 3: Update `unpackUv` to branch on file extension**

In `scripts/fetch-runtime.ts`, replace the body of `unpackUv(archivePath, destFile, target)` with logic that handles both `.tar.gz` (mac) and `.zip` (win):

```ts
async function unpackUv(archivePath: string, destFile: string, target: Target): Promise<void> {
  if (existsSync(destFile)) rmSync(destFile);
  await mkdir(dirname(destFile), { recursive: true });
  const extractDir = join(CACHE_DIR, `uv-extract-${target}`);
  if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });

  if (archivePath.endsWith('.zip')) {
    // Windows uv zip — payload is just `uv.exe` at the root.
    await spawn2('unzip', ['-q', '-o', archivePath, '-d', extractDir]);
    await spawn2('cp', [join(extractDir, 'uv.exe'), destFile]);
  } else {
    // macOS uv tar.gz — payload is `uv-<triple>/uv`.
    await spawn2('tar', ['-xzf', archivePath, '-C', extractDir]);
    const archDirName = target === 'mac-arm64' ? 'uv-aarch64-apple-darwin' : 'uv-x86_64-apple-darwin';
    await spawn2('cp', [join(extractDir, archDirName, 'uv'), destFile]);
  }
  await spawn2('chmod', ['+x', destFile]);
}
```

- [ ] **Step 4: Update `unpackFfmpeg` to handle the BtbN nested layout**

Replace the body of `unpackFfmpeg`:

```ts
async function unpackFfmpeg(archivePath: string, destFile: string, target: Target): Promise<void> {
  if (existsSync(destFile)) rmSync(destFile);
  await mkdir(dirname(destFile), { recursive: true });
  const extractDir = join(CACHE_DIR, `ffmpeg-extract-${target}`);
  if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  await spawn2('unzip', ['-q', '-o', archivePath, '-d', extractDir]);

  // Probe two known layouts in order:
  //   1. osxexperts.net (mac):  <extractDir>/ffmpeg            — single binary at root
  //   2. BtbN (win):            <extractDir>/<inner>/bin/ffmpeg.exe
  const macFlat = join(extractDir, 'ffmpeg');
  if (existsSync(macFlat)) {
    await spawn2('cp', [macFlat, destFile]);
  } else {
    // BtbN nested: <extractDir>/ffmpeg-*-win64-gpl-*/bin/ffmpeg.exe
    const { readdirSync } = await import('node:fs');
    const subdirs = readdirSync(extractDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    if (subdirs.length !== 1) {
      throw new Error(`expected exactly one nested directory in ffmpeg zip, found: ${subdirs.join(', ')}`);
    }
    const winExe = join(extractDir, subdirs[0]!, 'bin', 'ffmpeg.exe');
    if (!existsSync(winExe)) throw new Error(`ffmpeg.exe not found at ${winExe}`);
    await spawn2('cp', [winExe, destFile]);
  }
  await spawn2('chmod', ['+x', destFile]);
}
```

- [ ] **Step 5: Add `.exe` suffix to Windows destination paths in `fetchTarget`**

`installYtdlp` itself stays as-is — it just copies the cached file to a destination. The Windows-vs-mac distinction lives in the destination path the caller builds. Rewrite the body of `fetchTarget` so the three binary destinations carry the right suffix:

```ts
async function fetchTarget(target: Target): Promise<void> {
  console.log(`\n=== ${target} ===`);
  const archDir = join(OUT_DIR, target);
  const ext = target === 'win-x64' ? '.exe' : '';

  const pyMeta = VERSIONS.python.targets[target];
  if (!pyMeta) throw new Error(`No python entry for target ${target}`);
  const pyArchive = await ensureCached(pyMeta.url, pyMeta.sha256, `python-${VERSIONS.python.version}-${target}.tar.gz`);
  await unpackPython(pyArchive, join(archDir, 'python-runtime'));

  const uvMeta = VERSIONS.uv.targets[target];
  if (!uvMeta) throw new Error(`No uv entry for target ${target}`);
  const uvArchive = await ensureCached(
    uvMeta.url,
    uvMeta.sha256,
    `uv-${VERSIONS.uv.version}-${target}${target === 'win-x64' ? '.zip' : '.tar.gz'}`,
  );
  await unpackUv(uvArchive, join(archDir, `uv${ext}`), target);

  const ffMeta = VERSIONS.ffmpeg.targets[target];
  if (!ffMeta) throw new Error(`No ffmpeg entry for target ${target}`);
  const ffArchive = await ensureCached(ffMeta.url, ffMeta.sha256, `ffmpeg-${VERSIONS.ffmpeg.version}-${target}.zip`);
  await unpackFfmpeg(ffArchive, join(archDir, `ffmpeg${ext}`), target);

  const ytdlpMeta = VERSIONS.ytdlp.targets[target];
  if (!ytdlpMeta) throw new Error(`No yt-dlp entry for target ${target}`);
  const ytdlpFile = await ensureCached(ytdlpMeta.url, ytdlpMeta.sha256, `yt-dlp-${VERSIONS.ytdlp.version}-${target}${ext}`);
  await installYtdlp(ytdlpFile, join(archDir, `yt-dlp${ext}`));

  console.log(`  ✓ ${target} ready at ${archDir}`);
}
```

The uv cache filename branches on extension because the upstream uv release is `.tar.gz` on mac but `.zip` on win. The yt-dlp cache filename appends `${ext}` so the win-x64 download is cached as `yt-dlp-2026.03.17-win-x64.exe` (matters mostly for the chmod step inside `installYtdlp`, which is a no-op on `.exe` either way).

- [ ] **Step 6: Run the Windows fetch and verify all four binaries land in build-resources/win-x64/**

Run: `yarn tsx scripts/fetch-runtime.ts --target=win-x64`
Expected: fetches 4 archives (cached re-fetches use existing files), prints `✓ win-x64 ready at .../build-resources/win-x64`.

Verify:
```bash
ls -la build-resources/win-x64/
# Expected: python-runtime/ uv.exe ffmpeg.exe yt-dlp.exe
file build-resources/win-x64/ffmpeg.exe
# Expected: "PE32+ executable (console) x86-64, for MS Windows"
file build-resources/win-x64/python-runtime/python.exe
# Expected: "PE32+ executable (console) x86-64, for MS Windows"
```

If any `file` output reports the wrong format (e.g. Mach-O, ELF), check the unpack helper for the affected tool and the URL — the archive is likely correct but the extraction step picked the wrong inner path.

- [ ] **Step 7: Re-run mac fetch to make sure it still works**

Run: `yarn tsx scripts/fetch-runtime.ts --target=mac-arm64`
Expected: still produces `build-resources/mac-arm64/{python-runtime, uv, ffmpeg, yt-dlp}` (no `.exe` suffixes).

- [ ] **Step 8: Run the full test suite to confirm no regressions**

Run: `yarn test`
Expected: all tests still pass.

- [ ] **Step 9: Commit**

```bash
git add scripts/runtime-versions.json scripts/fetch-runtime.ts
git commit -m "$(cat <<'EOF'
feat(build): fetch python/uv/ffmpeg/yt-dlp for win-x64

Add win-x64 URLs + SHA-256s to runtime-versions.json (python-build-standalone
pc-windows-msvc-shared, uv 0.5.6 msvc zip, BtbN ffmpeg n7.1 win64-gpl with
libass, yt-dlp.exe 2026.03.17). Extend unpackUv to handle the zip layout
and unpackFfmpeg to probe BtbN's nested bin/ffmpeg.exe path. Destination
filenames now carry .exe on win-x64 (uv.exe, ffmpeg.exe, yt-dlp.exe), which
matches what electron-builder's ${ext} token will reference in extraResources.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Add Windows branch to `resolveRuntimePaths` (TDD)

**Files:**
- Modify: `src/main/infra/runtimePaths.ts`
- Modify: `src/main/infra/runtimePaths.test.ts`

- [ ] **Step 1: Add failing tests for the win32 branch**

Open `src/main/infra/runtimePaths.test.ts` and append these tests (inside the existing `describe('resolveRuntimePaths', () => { ... })` block, before the closing `})`):

```ts
  const WIN_PACKAGED_CTX = {
    isPackaged: true,
    resourcesPath: 'C:\\Users\\u\\AppData\\Local\\Programs\\Shorts AI\\resources',
    userDataPath: 'C:\\Users\\u\\AppData\\Roaming\\Shorts AI',
    repoRoot: 'C:\\unused-in-packaged',
    platform: 'win32' as NodeJS.Platform,
    arch: 'x64',
    fileExists: () => true,
  };

  const WIN_DEV_CTX = {
    isPackaged: false,
    resourcesPath: 'C:\\unused-in-dev',
    userDataPath: 'C:\\unused-in-dev',
    repoRoot: 'C:\\repo',
    platform: 'win32' as NodeJS.Platform,
    arch: 'x64',
    fileExists: (p: string) => p === 'C:\\repo\\build-resources\\win-x64\\ffmpeg.exe',
  };

  it('Windows packaged: uses .exe suffix and Scripts\\python.exe venv layout', () => {
    const r = resolveRuntimePaths(WIN_PACKAGED_CTX);
    expect(r.uvBinary).toBe(join(WIN_PACKAGED_CTX.resourcesPath, 'uv.exe'));
    expect(r.pythonRuntime).toBe(join(WIN_PACKAGED_CTX.resourcesPath, 'python-runtime', 'python.exe'));
    expect(r.ffmpegBinary).toBe(join(WIN_PACKAGED_CTX.resourcesPath, 'ffmpeg.exe'));
    expect(r.ytdlpBinary).toBe(join(WIN_PACKAGED_CTX.resourcesPath, 'yt-dlp.exe'));
    expect(r.venvPath).toBe(join(WIN_PACKAGED_CTX.userDataPath, 'sidecar-venv'));
    expect(r.sidecarSpawn.command).toBe(
      join(WIN_PACKAGED_CTX.userDataPath, 'sidecar-venv', 'Scripts', 'python.exe'),
    );
  });

  it('Windows dev with bundled ffmpeg present: ffmpegBinary points at build-resources/win-x64/ffmpeg.exe', () => {
    const r = resolveRuntimePaths(WIN_DEV_CTX);
    expect(r.ffmpegBinary).toBe('C:\\repo\\build-resources\\win-x64\\ffmpeg.exe');
  });

  it('Windows dev without bundled ffmpeg: ffmpegBinary falls back to "ffmpeg.exe"', () => {
    const r = resolveRuntimePaths({ ...WIN_DEV_CTX, fileExists: () => false });
    expect(r.ffmpegBinary).toBe('ffmpeg.exe');
  });
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `yarn test src/main/infra/runtimePaths.test.ts`
Expected: 3 new tests FAIL (paths don't contain `.exe`, sidecarSpawn.command uses `bin/python` not `Scripts\python.exe`, etc.). 3 existing mac tests still pass.

- [ ] **Step 3: Add the win32 branch to `resolveRuntimePaths`**

Open `src/main/infra/runtimePaths.ts`. Replace the entire body of `resolveRuntimePaths` with:

```ts
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
    return {
      uvBinary: join(r, `uv${exe}`),
      pythonRuntime: join(r, 'python-runtime', ...pythonInRuntime),
      venvPath,
      requirementsPath: join(r, 'requirements.txt'),
      ffmpegBinary: join(r, `ffmpeg${exe}`),
      ytdlpBinary: join(r, `yt-dlp${exe}`),
      sidecarCwd: r,
      sidecarSpawn: {
        command: join(venvPath, venvBin, `python${exe}`),
        args: ['-m', 'shorts_sidecar'],
      },
      sidecarEnv: { PYTHONPATH: join(r, 'sidecar-src') },
    };
  }

  // Dev mode — build-resources/<platform>-<arch>/.
  const targetDir = `${isWin ? 'win' : 'mac'}-${ctx.arch}`;
  const bundledFfmpeg = join(ctx.repoRoot, 'build-resources', targetDir, `ffmpeg${exe}`);
  const ffmpegBinary = ctx.fileExists(bundledFfmpeg) ? bundledFfmpeg : `ffmpeg${exe}`;
  return {
    uvBinary: 'uv',
    pythonRuntime: isWin ? 'python.exe' : 'python3.11',
    venvPath: join(ctx.repoRoot, 'sidecar', '.venv'),
    requirementsPath: join(ctx.repoRoot, 'sidecar', 'requirements.txt'),
    ffmpegBinary,
    ytdlpBinary: '',
    sidecarCwd: join(ctx.repoRoot, 'sidecar'),
    sidecarSpawn: { command: 'uv', args: ['run', 'python', '-m', 'shorts_sidecar'] },
    sidecarEnv: {},
  };
}
```

- [ ] **Step 4: Run the tests and verify all 6 pass**

Run: `yarn test src/main/infra/runtimePaths.test.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Run typecheck and full test suite**

Run: `yarn typecheck && yarn test`
Expected: EXIT=0; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/main/infra/runtimePaths.ts src/main/infra/runtimePaths.test.ts
git commit -m "$(cat <<'EOF'
feat(main): add Windows branch to resolveRuntimePaths

Windows packaged + dev paths now resolve with .exe suffixes (uv.exe,
ffmpeg.exe, yt-dlp.exe), python-runtime/python.exe at the root (instead
of bin/python3.11), and sidecar-venv/Scripts/python.exe as the spawn
command (instead of sidecar-venv/bin/python). Dev mode looks up the
bundled ffmpeg in build-resources/win-x64/ on Windows hosts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Update `electron-builder.yml` with Windows target and parameterised extraResources

**Files:**
- Modify: `electron-builder.yml`

- [ ] **Step 1: Replace `electron-builder.yml` with the new config**

Overwrite the file with:

```yaml
appId: com.bobpark.shorts-ai
productName: Shorts AI
copyright: Copyright (c) 2026 Bob Park
directories:
  output: out
files:
  - out/main/**
  - out/preload/**
  - out/renderer/**
  - package.json
  - '!**/*.test.*'
  - '!**/__tests__/**'
asar: true
asarUnpack:
  # better-sqlite3 has a native .node binding that can't run from inside asar
  - '**/node_modules/better-sqlite3/**'

mac:
  category: public.app-category.video
  target:
    - target: dmg
      arch: [arm64]
  identity: null
  hardenedRuntime: false
  minimumSystemVersion: '12.0'

win:
  target:
    - target: nsis
      arch: [x64]
  # We don't sign — explicitly disable so electron-builder doesn't try to
  # invoke signtool via wine (which would fail on macOS hosts).
  signAndEditExecutable: false

nsis:
  oneClick: false                        # show install wizard, let user pick install dir
  perMachine: false                      # install into %LOCALAPPDATA% (no admin prompt)
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true
  shortcutName: Shorts AI

# ${platform} → 'mac' | 'win'; ${arch} → 'arm64' | 'x64'; ${ext} → '' | '.exe'.
# One block serves both targets.
extraResources:
  - from: build-resources/${platform}-${arch}/python-runtime
    to: python-runtime
  - from: build-resources/${platform}-${arch}/uv${ext}
    to: uv${ext}
  - from: build-resources/${platform}-${arch}/ffmpeg${ext}
    to: ffmpeg${ext}
  - from: build-resources/${platform}-${arch}/yt-dlp${ext}
    to: yt-dlp${ext}
  - from: sidecar/requirements.txt
    to: requirements.txt
  - from: sidecar/src
    to: sidecar-src

dmg:
  title: Shorts AI ${version}
  iconSize: 128
  contents:
    - x: 130
      y: 220
      type: file
    - x: 410
      y: 220
      type: link
      path: /Applications
```

- [ ] **Step 2: Smoke-test mac config (regression check)**

Build the mac path once to confirm the new extraResources tokens still resolve to the existing mac-arm64 bundle:

```bash
yarn fetch-runtime:mac && yarn build && electron-builder build --mac
```

(Skip this step if the package.json scripts haven't been updated yet — they ship in Task 7. In that case run the old `yarn package` command instead.)

Expected: `out/Shorts AI-<version>-arm64.dmg` is created (file size around 190 MB), and inside the mounted DMG `Shorts AI.app/Contents/Resources/` contains `ffmpeg`, `uv`, `yt-dlp` (no .exe), and `python-runtime/`. The dmg verification is mostly about "the build completed without an unresolved-token error".

If electron-builder errors with `from path does not exist: build-resources/mac-arm64/ffmpeg`, the rename in Task 2 didn't complete — re-run `yarn tsx scripts/fetch-runtime.ts --target=mac-arm64`.

- [ ] **Step 3: Commit**

```bash
git add electron-builder.yml
git commit -m "$(cat <<'EOF'
feat(build): add win nsis target and parameterise extraResources paths

electron-builder.yml now declares a Windows x64 NSIS target alongside
the existing mac arm64 DMG, with a single extraResources block that uses
\${platform}-\${arch}/<tool>\${ext} tokens. mac builds resolve these to
build-resources/mac-arm64/uv (etc.); win builds resolve to
build-resources/win-x64/uv.exe (etc.). signAndEditExecutable is forced
off so the NSIS step doesn't try to invoke wine signtool on cross-build.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Split `package.json` scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Replace the `scripts` block**

Open `package.json`. Replace the entire `"scripts": { ... }` block with:

```jsonc
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",

    "fetch-runtime:mac": "tsx scripts/fetch-runtime.ts --target=mac-arm64",
    "fetch-runtime:win": "tsx scripts/fetch-runtime.ts --target=win-x64",

    "package:mac": "yarn fetch-runtime:mac && yarn build && yarn rebuild:electron && electron-builder build --mac",
    "package:win": "yarn fetch-runtime:win && yarn build && yarn rebuild:better-sqlite3:win && electron-builder build --win",
    "package": "yarn package:mac",

    "preview": "electron-vite preview",
    "typecheck": "tsc -b --noEmit",
    "lint": "eslint .",
    "format": "prettier --write .",
    "test": "ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron ./node_modules/.bin/vitest run",
    "test:watch": "ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron ./node_modules/.bin/vitest",

    "rebuild:electron": "electron-rebuild -f -w better-sqlite3",
    "rebuild:better-sqlite3:win": "electron-rebuild -f -w better-sqlite3 --arch=x64 --platform=win32",
    "postinstall": "electron-rebuild -f -w better-sqlite3"
  },
```

Key changes:
- `prepackage` hook removed (was `tsx scripts/fetch-runtime.ts`) — each `package:*` script now calls its own `fetch-runtime:*` explicitly.
- `package:mac` re-invokes `rebuild:electron` (mac-native rebuild) before `electron-builder` so a prior `yarn package:win` leaving a Windows `.node` in `node_modules` doesn't poison the mac DMG. This is the explicit fix for the gotcha called out in the spec.
- `package:win` invokes `rebuild:better-sqlite3:win` (cross-arch rebuild) to download the Windows prebuild.
- `package` retained as an alias of `package:mac` so anyone with muscle memory or scripts referencing the bare command keeps working.

- [ ] **Step 2: Smoke-test both new scripts**

Run a full mac build via the new alias:

```bash
yarn package:mac
```

Expected: produces `out/Shorts AI-<version>-arm64.dmg`. Wall-clock ~5-10 minutes depending on cache state.

Then run the Windows cross-build (requires `wine-stable` installed via Task 8's docs; if not yet installed, expect electron-builder to fail at the NSIS step with `Cannot find wine` — that's acceptable for this step's signal, since steps 3-6 of the script (fetch, build, native rebuild) all run before NSIS):

```bash
yarn package:win
```

Expected (with wine installed): produces `out/Shorts AI Setup <version>.exe`.
Expected (without wine): script runs through `fetch-runtime:win`, `build`, `rebuild:better-sqlite3:win`, then fails at the electron-builder step with a clear wine-missing error. The Windows runtime bundle in `build-resources/win-x64/` is populated; the Windows .node in `node_modules/better-sqlite3/build/Release/` is a PE binary. Sanity-check with:

```bash
file node_modules/better-sqlite3/build/Release/better_sqlite3.node
# Expected: "PE32+ executable (DLL) (console) x86-64, for MS Windows"
```

After confirming, restore the macOS native binary so subsequent dev/test runs don't crash:

```bash
yarn rebuild:electron
```

(This is documented in `docs/build-windows.md` in Task 8.)

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "$(cat <<'EOF'
feat(build): split package scripts into mac and win, drop prepackage hook

Add yarn package:win (fetch-runtime:win → build → rebuild:better-sqlite3:win
→ electron-builder --win) and yarn package:mac (fetch-runtime:mac → build →
rebuild:electron → electron-builder --mac). yarn package stays as an alias
for package:mac. The implicit prepackage hook is removed so package:win
doesn't re-fetch mac binaries on every run. package:mac re-runs the mac
native rebuild defensively in case a prior win build left a Windows .node
behind.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Write the Windows build developer guide and final regression check

**Files:**
- Create: `docs/build-windows.md`

- [ ] **Step 1: Create the documentation**

Create `docs/build-windows.md` with exact contents:

```markdown
# Building the Windows installer (from macOS)

This guide walks through cross-building the Windows NSIS installer from a macOS host. The macOS host produces the artifact; verification happens on a Windows VM (see "Verifying" below).

## Prerequisites

- macOS host (Apple Silicon recommended; Intel works but is untested for this build).
- Node 24+, Yarn 4 (the repo's `.yarnrc.yml` pins this).
- `wine-stable` — required for electron-builder's NSIS step:

  ```bash
  brew install --cask --no-quarantine wine-stable
  ```

  Without wine, `yarn package:win` fails at the NSIS step with an error pointing at `makensis`. Everything up to that step (runtime fetch, electron-vite build, better-sqlite3 Windows rebuild) still runs, so the failure is recoverable — install wine and re-run.

## Building

```bash
yarn install         # one-time
yarn package:win
```

The build is roughly:

1. **fetch-runtime:win** — downloads python (windows-msvc-shared), uv (msvc zip), ffmpeg (BtbN n7.1 libass-enabled), yt-dlp.exe into `build-resources/win-x64/`. Cached after first run; SHAs in `scripts/runtime-versions.json`.
2. **electron-vite build** — compiles main/preload/renderer into `out/{main,preload,renderer}/`.
3. **rebuild:better-sqlite3:win** — `@electron/rebuild --platform=win32 --arch=x64` downloads the prebuilt Windows `better_sqlite3.node` via prebuild-install. Replaces the macOS binary in `node_modules/better-sqlite3/build/Release/` in place.
4. **electron-builder build --win** — packages everything into `out/Shorts AI Setup <version>.exe`.

Wall-clock: ~5-10 minutes after first-run caches are warm.

## Verifying

Before testing on a Windows machine, confirm the bundled native module is correct:

```bash
file node_modules/better-sqlite3/build/Release/better_sqlite3.node
# Expected: "PE32+ executable (DLL) (console) x86-64, for MS Windows"
# If you see "Mach-O", the rebuild step didn't run — re-run yarn package:win.
```

Optional but recommended:

```bash
file build-resources/win-x64/ffmpeg.exe
# Expected: "PE32+ executable (console) x86-64, for MS Windows"
```

Functional verification requires Windows 10 or 11 x64 — use Parallels, UTM, VMware, or a bare-metal machine:

1. Copy `out/Shorts AI Setup <version>.exe` to the VM.
2. Double-click → SmartScreen will warn "Windows protected your PC" because the installer is unsigned. Click "More info" → "Run anyway".
3. Step through the install wizard. Default path is `%LOCALAPPDATA%\Programs\Shorts AI\` (per-user, no admin prompt).
4. Launch Shorts AI. Confirm the Python sidecar boots (open Settings; if the status pill in the UI is green/ready, the venv was created and the sidecar handshake worked). The first launch creates `%APPDATA%\Shorts AI\sidecar-venv\` (uv pip install on the bundled python), which takes ~30-60 seconds.
5. Sanity-check the render path: download a short YouTube video, run transcribe → highlights → render. The output `.mp4` should have the title bar and word-level captions burned in (libass regression check).
6. Uninstall via Control Panel → Programs. Confirm Program Files and `%APPDATA%\Shorts AI\` are gone.

## Restoring the mac dev environment after a Windows build

`yarn package:win` overwrites `node_modules/better-sqlite3/build/Release/better_sqlite3.node` with the Windows binary. If you go straight back to `yarn dev` or `yarn test` on macOS, the app crashes at startup with a `dlopen` error. Restore the macOS native binary with:

```bash
yarn rebuild:electron
```

`yarn package:mac` does this automatically as its first step — only `dev`/`test` are affected.

## Known limitations

- **No code signing.** SmartScreen warnings are expected.
- **No auto-update.** Users have to download a new installer for each version.
- **ARM64 Windows not supported.** `mediapipe` doesn't publish arm64-windows wheels; cross-architecture support requires either a wheel becoming available or replacing the face detection backend.
- **Build artifact only — verification is manual.** No automated cross-platform CI. The Testing section of `docs/superpowers/specs/2026-05-11-windows-build-design.md` lists the manual VM checklist.
- **wine-stable on macOS Sequoia (15.x).** If `brew install --cask wine-stable` doesn't work on the current macOS version, try the `wine-staging` cask or download wine-crossover from <https://github.com/Gcenx/macOS_Wine_builds>. The exact wine flavor isn't load-bearing — anything that can run `makensis.exe` is sufficient.
```

- [ ] **Step 2: Final regression check on mac DMG build**

After all prior tasks have landed, run one full mac build end-to-end to verify nothing is broken:

```bash
yarn rebuild:electron      # restore mac native if a win build ran recently
yarn package:mac
```

Expected: `out/Shorts AI-<version>-arm64.dmg` present and around 190 MB. Mount it, drag-install into a scratch location, launch — the app should run normally on the host macOS machine.

If any step fails:
- `fetch-runtime:mac` errors → check `scripts/runtime-versions.json` was preserved correctly (mac-arm64 entries intact).
- `electron-builder build --mac` errors with "from path does not exist" → verify `build-resources/mac-arm64/` is populated.
- App launches but crashes immediately → `file node_modules/better-sqlite3/build/Release/better_sqlite3.node` to confirm it's Mach-O and not PE.

- [ ] **Step 3: Commit**

```bash
git add docs/build-windows.md
git commit -m "$(cat <<'EOF'
docs: developer guide for cross-building the Windows installer

docs/build-windows.md covers wine prerequisites, the yarn package:win
pipeline step by step, native module sanity check (file <name>.node →
PE32+), manual Windows VM verification flow, and the gotcha that
package:win leaves a Windows .node in node_modules so yarn dev/test
need yarn rebuild:electron afterwards.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final integration check

After Task 8 ships, the working tree should be clean and `git log --oneline` should show eight new commits on top of the merge point. Run one final pass to confirm the whole pipeline holds together end-to-end:

```bash
yarn typecheck      # EXIT=0
yarn test           # 211+ tests pass (the new resolveRuntimePaths + parseTargetsArg tests add ~8)
yarn package:mac    # produces out/Shorts AI-<version>-arm64.dmg
# (Windows verification on a VM, per docs/build-windows.md — outside this checklist)
```

When all three pass, merge `m14-windows-build` back into `master` the same way `m13-shorts-framing` was merged (`git checkout master && git merge --no-ff m14-windows-build`).
