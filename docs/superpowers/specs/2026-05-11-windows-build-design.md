# Windows Build — Cross-Compile NSIS Installer From macOS

**Status:** Spec, awaiting plan
**Date:** 2026-05-11
**Author:** Bob Park (with Claude)
**Scope:** Add a second target to the existing electron-builder pipeline so the same source tree produces a Windows x64 NSIS installer alongside the current macOS arm64 DMG. Build runs from the macOS host via `wine`; runtime verification happens on a Windows VM. No CI, no code signing, no auto-update.

---

## Problem

Today the app builds only for macOS arm64. `electron-builder.yml` declares a single `mac` target, `scripts/fetch-runtime.ts` is hardcoded to `fetchArch('arm64')` and only knows `*-apple-darwin` URLs in `runtime-versions.json`, and `src/main/main.ts` resolves runtime paths assuming Unix layout (`bin/python3.11`, no `.exe` suffix, `bin/` inside the venv). Shipping to any Windows user is currently impossible without rewriting all three.

We want to ship a Windows installer without standing up CI, without buying a code-signing certificate, and without rearchitecting the runtime fetch pipeline into something exotic. The macOS path must stay working unchanged after the refactor.

## Goals

1. Running `yarn package:win` on the developer's macOS host produces `out/Shorts AI Setup ${version}.exe` — an NSIS installer that, on a Windows 10/11 x64 machine, installs the app, drops the bundled Python runtime + ffmpeg + uv + yt-dlp into Program Files (per-user), and launches successfully.
2. `yarn package:mac` continues to produce the existing arm64 DMG with no behavioral change.
3. `runtime-versions.json`, `fetch-runtime.ts`, and `electron-builder.yml` use a single platform+arch convention (`mac-arm64`, `win-x64`) so adding future targets (e.g. `win-arm64`, `mac-x64`) is data-only.
4. `src/main/main.ts` `resolveRuntimePaths()` returns correct executable paths and venv layout on `process.platform === 'win32'` (with `.exe` suffixes and `Scripts/` instead of `bin/`).
5. The Windows ffmpeg binary that ships with the installer is built with `--enable-libass` so the `subtitles=` filter (title bar + word-level captions) works the same as on macOS.
6. A `docs/build-windows.md` guide tells the next developer how to set up wine, run the build, and verify the output.

## Non-Goals

- Code signing on either platform (macOS is currently `identity: null`; Windows ships unsigned and lets the user click through SmartScreen).
- ARM64 Windows. `mediapipe` does not publish arm64-windows wheels, and the user base for this app on Snapdragon X is currently zero.
- macOS x64 (Intel) revival. The `x64` rows in the old `runtime-versions.json` were already disabled; this spec drops them. They can be re-added as a data entry in a future change.
- GitHub Actions / CI. Deliberately deferred — the build runs locally from macOS, the same way mac builds do today.
- Auto-update (electron-updater). Not used on mac either; out of scope.
- Cross-platform test automation. Windows correctness is verified by hand in a VM. Unit tests still cover the `resolveRuntimePaths` branching.
- Native Windows dev environment (`yarn dev` on a Windows host). Cross-build only — actual development still happens on the macOS workstation.

---

## Architecture

**Approach: platform-aware refactor, two explicit targets.**

The runtime fetch + electron-builder config + main-process path resolver each get parameterised on `<platform>-<arch>`. `package.json` exposes two scripts (`package:mac`, `package:win`), each of which fetches only its own runtime bundle and invokes electron-builder for the corresponding target. The macOS path keeps producing the existing DMG; the Windows path additionally rebuilds `better-sqlite3` for `win32-x64` before NSIS packaging so the native `.node` binary inside `app.asar.unpacked` is a Windows PE binary, not a Mach-O.

```
yarn package:win
  ├─ tsx scripts/fetch-runtime.ts --target=win-x64
  │     downloads python (pc-windows-msvc tar.gz), uv (windows zip),
  │     ffmpeg (libass-enabled windows zip), yt-dlp.exe → build-resources/win-x64/
  ├─ electron-vite build  (renderer + main + preload to out/)
  ├─ electron-rebuild --platform=win32 --arch=x64 -w better-sqlite3
  │     fetches prebuilt windows .node via prebuild-install
  └─ electron-builder build --win
        reads electron-builder.yml, resolves ${platform}-${arch} to win-x64,
        bundles extraResources from build-resources/win-x64/, runs NSIS
        through wine, emits out/Shorts AI Setup <version>.exe
```

The `--target=` arg is the single switch that picks which bundle to fetch; both fetcher and builder consume the same `<platform>-<arch>` key from `runtime-versions.json` and `electron-builder.yml` respectively.

---

## Components

### 1. `scripts/runtime-versions.json` — flattened by platform key

Schema today has per-tool `arm64` / `x64` objects assuming macOS. New schema groups by `targets` map keyed on `<platform>-<arch>`:

```json
{
  "python": {
    "version": "3.11.10",
    "release": "20241016",
    "targets": {
      "mac-arm64": { "url": "...aarch64-apple-darwin-install_only.tar.gz", "sha256": "..." },
      "win-x64":   { "url": "...x86_64-pc-windows-msvc-shared-install_only.tar.gz", "sha256": "..." }
    }
  },
  "uv":     { "version": "0.5.6",  "targets": { "mac-arm64": {...}, "win-x64": {...} } },
  "ffmpeg": { "version": "7.1",    "targets": { "mac-arm64": {...}, "win-x64": {...} } },
  "ytdlp":  { "version": "2026.03.17", "targets": { "mac-arm64": {...}, "win-x64": {...} } }
}
```

The existing macOS x64 entries are dropped (already disabled). The `release` field on `python` stays as a top-level metadata field — it does not vary by target for a given python version. Concrete URLs to pin:

- **python**: `python-build-standalone` 20241016, `cpython-3.11.10+20241016-x86_64-pc-windows-msvc-shared-install_only.tar.gz`. The `shared` variant is required (it ships `python311.dll`) so embedded interpreters work.
- **uv**: `0.5.6`, `uv-x86_64-pc-windows-msvc.zip` from the astral-sh release.
- **ffmpeg**: BtbN's `ffmpeg-master-latest-win64-gpl.zip` (full build — confirmed to include `--enable-libass` + `--enable-libfreetype` + `--enable-fontconfig`). Pin a dated release tag rather than `master-latest` so SHA stays stable.
- **yt-dlp**: matching `2026.03.17` release, `yt-dlp.exe` (single PE binary).

The contributor adding this spec to code is responsible for fetching each URL once, recording the actual SHA-256, and committing those values — the spec does not pre-fill SHAs.

### 2. `scripts/fetch-runtime.ts` — accepts `--target=`

New entry point:

```ts
type Target = 'mac-arm64' | 'win-x64';

function parseTargetsArg(): Target[] {
  const arg = process.argv.find(a => a.startsWith('--target='))?.split('=')[1];
  if (arg) return arg.split(',') as Target[];
  // Default: detect from host. Win cross-build always requires --target=win-x64 explicit.
  if (process.platform === 'darwin' && process.arch === 'arm64') return ['mac-arm64'];
  throw new Error('No --target= given and host platform/arch is not auto-mappable');
}

async function fetchTarget(target: Target) {
  const archDir = join(OUT_DIR, target);  // build-resources/win-x64
  await fetchPython(target, archDir);
  await fetchUv(target, archDir);
  await fetchFfmpeg(target, archDir);
  await fetchYtdlp(target, archDir);
}
```

Per-tool unpack logic branches on file extension (not platform — the extension *is* the signal):

- **python** (.tar.gz both targets): existing `tar -xzf … --strip-components=1` logic works for the windows tarball too; payload contains `python.exe`, `Lib/`, `DLLs/`, `python311.dll` at the root after stripping the top dir.
- **uv** (.tar.gz mac / .zip win): branch on file extension. mac path stays; win path uses `unzip` → extracts `uv.exe`. Output file is `build-resources/<target>/uv` on mac and `build-resources/<target>/uv.exe` on win.
- **ffmpeg** (.zip both): both use `unzip`, but the win zip nests `bin/ffmpeg.exe` (BtbN layout) while the mac zip has `ffmpeg` at root. Probe both locations after unzip and copy whichever exists.
- **yt-dlp** (single file both targets): mac is `yt-dlp_macos` (POSIX binary), win is `yt-dlp.exe`. Single `cp` + `chmod +x` (chmod on .exe is a no-op on a future Windows NTFS extract, harmless on the macOS cache).

The cached archive filename embeds the target, so `mac-arm64` and `win-x64` caches don't collide:

```
build-resources/.cache/ffmpeg-7.1-win-x64.zip
build-resources/.cache/ffmpeg-7.1-mac-arm64.zip
```

The chmod call is unconditional. On macOS the runtime-extracted Windows binaries get +x bits set, which has no effect on the eventual NSIS payload (NTFS uses ACLs, not POSIX modes) but matches the existing pattern and avoids platform branching in the fetcher.

### 3. `electron-builder.yml` — add `win` section, parameterise paths

```yaml
mac:
  category: public.app-category.video
  target: [{ target: dmg, arch: [arm64] }]
  identity: null
  hardenedRuntime: false
  minimumSystemVersion: '12.0'

win:
  target: [{ target: nsis, arch: [x64] }]
  signAndEditExecutable: false      # don't try to sign — wine signtool would fail

nsis:
  oneClick: false                    # show install wizard, let user pick path
  perMachine: false                  # install into %LOCALAPPDATA% — no admin prompt
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true
  shortcutName: Shorts AI

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
```

`${platform}`, `${arch}`, `${ext}` are electron-builder built-in tokens. `${platform}` resolves to `mac` / `win`; `${arch}` to `arm64` / `x64`; `${ext}` to empty on mac and `.exe` on win. The single `extraResources` block serves both targets.

The existing `arm64/` resource directory must be renamed to `mac-arm64/` so the token expansion finds it. This is a one-time migration; the rename happens as part of the runtime fetch refactor (the fetcher writes to the new path on first run after the change).

### 4. `src/main/main.ts` — Windows branch in `resolveRuntimePaths()`

Three platform-shaped knobs replace hardcoded Unix paths:

```ts
const isWin = process.platform === 'win32';
const exe = isWin ? '.exe' : '';
const venvBin = isWin ? 'Scripts' : 'bin';  // uv-created venv layout
const pythonInRuntime = isWin
  ? ['python.exe']                  // python-build-standalone windows layout
  : ['bin', 'python3.11'];          // unix layout
```

Both `app.isPackaged` (production) and dev branches use these. The packaged branch resolves binaries inside `process.resourcesPath` with `.exe` suffixes; the dev branch builds `build-resources/<platform>-<arch>/` paths the same way.

The sidecar spawn command becomes `join(venvPath, venvBin, 'python' + exe)`, i.e. `…\sidecar-venv\Scripts\python.exe` on Windows. `uv pip install -r requirements.txt` (the first-boot bootstrap that creates that venv) is unchanged — uv itself handles the windows venv layout correctly.

LLM model and history database storage relies on Electron's `app.getPath('userData')`, which already resolves to `%APPDATA%\Shorts AI\` on Windows. No code change needed for those paths.

### 5. `package.json` — split scripts

```jsonc
{
  "scripts": {
    "fetch-runtime:mac": "tsx scripts/fetch-runtime.ts --target=mac-arm64",
    "fetch-runtime:win": "tsx scripts/fetch-runtime.ts --target=win-x64",

    "package:mac": "yarn fetch-runtime:mac && yarn build && electron-builder build --mac",
    "package:win": "yarn fetch-runtime:win && yarn build && yarn rebuild:better-sqlite3:win && electron-builder build --win",
    "package":     "yarn package:mac",                          // back-compat alias

    "rebuild:better-sqlite3:win": "electron-rebuild -f -w better-sqlite3 --arch=x64 --platform=win32",

    // unchanged: dev, build, typecheck, lint, format, test, test:watch,
    // rebuild:electron, postinstall
  }
}
```

The old `prepackage` hook is dropped: it ran the legacy single-target fetcher before every `yarn package`, which is now redundant because `package:mac` / `package:win` each call their own fetcher script explicitly. Keeping `prepackage` would re-fetch mac binaries every time the user runs `package:win`, wasting time and cache.

### 6. Native module rebuild (`better-sqlite3`)

`@electron/rebuild` called with `--platform=win32 --arch=x64` invokes prebuild-install, which downloads the prebuilt windows-x64 `.node` from better-sqlite3's GitHub releases. No Visual Studio toolchain needed on the macOS host. The output replaces `node_modules/better-sqlite3/build/Release/better_sqlite3.node` in-place with the windows PE binary just before electron-builder collects it.

Because this overwrites the macOS-built native binary in `node_modules/`, running `yarn package:win` and then `yarn package:mac` in sequence would package the windows .node into the mac DMG (and the resulting mac app would crash on load with a "wrong architecture" `dlopen` error). The existing `postinstall` only re-runs on `yarn install`, so it doesn't protect against this. The plan-writing phase will pick one of two fixes: (a) always call `yarn rebuild:electron` as the first step of `package:mac`, or (b) detect stale-arch by reading the magic bytes of the existing `.node` and rebuild conditionally. This spec documents the gotcha and leaves the choice open.

### 7. Wine + documentation

`wine-stable` is a hard prerequisite for `package:win` on macOS. electron-builder invokes NSIS's `makensis` through wine when the build host is non-Windows. No pre-check in our scripts — electron-builder produces a clear error if wine is missing.

`docs/build-windows.md` lives alongside the existing setup docs and covers: prerequisites (wine install command), build command, expected output path, sanity-check command to confirm the bundled `better_sqlite3.node` is a PE binary, and the manual VM verification step.

---

## Data flow on Windows at runtime

Identical to macOS except for paths. The relevant entry points:

1. **App launch** → `main.ts` resolves runtime paths → `process.resourcesPath` is `C:\Users\<user>\AppData\Local\Programs\Shorts AI\resources\` (per-user NSIS install).
2. **First-boot venv creation** → `uv.exe pip install -r requirements.txt --python python-runtime\python.exe --target sidecar-venv` runs in the userData directory. Creates `sidecar-venv\Scripts\python.exe` + `sidecar-venv\Lib\site-packages\`.
3. **Sidecar spawn** → `spawn(sidecar-venv\Scripts\python.exe, ['-m', 'shorts_sidecar'])` with `PYTHONPATH=resources\sidecar-src`.
4. **ffmpeg / yt-dlp** → spawned directly from `resources\ffmpeg.exe` / `resources\yt-dlp.exe`.
5. **history DB / LLM model** → `app.getPath('userData')` → `%APPDATA%\Shorts AI\history.db` and `…\models\gemma-3-4b-it-Q4_K_M.gguf`.

No file is written under Program Files at runtime (the per-user `perMachine: false` NSIS install puts the app in `%LOCALAPPDATA%\Programs\Shorts AI`, which the user already owns — Windows write protections are not triggered).

---

## Error handling

- **`fetch-runtime` SHA mismatch on a windows URL**: same as today — throws, leaves `.partial` file, surfaces in console. Pinned SHAs from `runtime-versions.json` are the contract.
- **wine missing during `package:win`**: electron-builder fails its NSIS step. Documented in `build-windows.md`; no extra preflight added.
- **`electron-rebuild --platform=win32` cannot fetch prebuild**: prebuild-install falls back to a source build, which would fail on macOS without MSVC. We accept the failure — it surfaces clearly and the contributor knows to debug from there. (better-sqlite3 publishes prebuilds reliably; this is rare.)
- **Windows runtime: bundled `ffmpeg.exe` missing libass**: identical symptom to the recent macOS bug — `subtitles=` filter silently skips. Mitigation: the contributor picking the BtbN release URL runs `ffmpeg.exe -filters | findstr subtitles` once on a Windows VM (or reads BtbN's published configure flags) before committing the SHA. No in-app preflight is added; the manual VM verification step in Testing covers the regression case.
- **SmartScreen on installer launch**: documented as expected behavior. No mitigation in scope.

---

## Testing

**Unit tests** (vitest, run on macOS):

- Add a test for `resolveRuntimePaths()` that stubs `process.platform = 'win32'` and asserts `.exe` suffixes, `Scripts\python.exe` venv layout, and `win-x64` dev directory. Add a complementary `darwin` case to lock the existing behavior in. (`process.platform` is currently read directly; the test will need a small refactor to allow injection, or use `vi.stubGlobal` on the `process` reference.)
- Add a test for `fetch-runtime`'s `parseTargetsArg()` covering: explicit `--target=win-x64`, comma list, default host detection, unknown target → throws.

**Manual verification** (Windows VM):

1. Copy `out/Shorts AI Setup <version>.exe` to a Windows 10 x64 VM (Parallels / UTM / VMware).
2. Run the installer, accept the wizard defaults.
3. Launch the app; confirm sidecar boots (Python + uv working), download a short youtube clip, transcribe, extract highlights, render. Validate the rendered .mp4 has the title bar and word-level subtitles burned in (regression check on libass).
4. Quit and uninstall via Control Panel; confirm Program Files and `%APPDATA%\Shorts AI\` are cleaned.

No automated cross-platform CI added. The macOS-only test suite plus the documented manual VM checklist is the contract.

---

## Open questions / decisions deferred to the plan

- Exact `electron-rebuild` invocation order vs. the macOS-leaves-stale-`.node` problem (note in Components §6). The plan will pick: explicit `rebuild:electron` step at the start of `package:mac`, or a hash-based "do I need to rebuild?" guard.
- Whether to drop `postinstall: electron-rebuild` entirely once both `package:*` scripts manage their own rebuilds. Probably yes, but not in scope for this spec.
- BtbN ffmpeg release tag vs. a pinned snapshot URL. The plan will choose one and record its SHA.
