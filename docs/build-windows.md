# Building the Windows installer (from macOS)

This guide walks through cross-building the Windows NSIS installer from a macOS host. The macOS host produces the artifact; verification happens on a Windows VM (see "Verifying" below).

## Prerequisites

- macOS host (Apple Silicon recommended; Intel works but is untested for this build).
- Node 24+, Yarn 4 (the repo's `.yarnrc.yml` pins this).
- **Wine is required** (`brew install --cask wine-stable`; Apple Silicon also needs Rosetta 2: `softwareupdate --install-rosetta --agree-to-license`).

electron-builder 25.x bundles its own NSIS makensis and compiles the **installer** directly on the macOS host (no wine needed for that). However, it generates the **uninstaller** by *executing the just-built Windows installer stub* in a temp area to emit `Uninstall …exe` — a Windows PE that cannot run on macOS without wine. Without wine, electron-builder still produces an uninstaller but its embedded NSIS CRC is wrong, so running it on Windows fails at launch with **"NSIS Error — Installer integrity check has failed"** (the *installer* is unaffected and installs fine). Hence wine is mandatory for a working uninstaller. (Earlier revisions of this guide incorrectly claimed "no wine required" — that held only for the installer.)

## Building

```bash
yarn install         # one-time
yarn package:win
```

The build is roughly:

1. **fetch-runtime:win** — downloads python (windows-msvc-shared), uv (msvc zip), ffmpeg (BtbN n7.1+ libass-enabled), yt-dlp.exe into `build-resources/win-x64/`. Cached after first run; SHAs in `scripts/runtime-versions.json`.
2. **electron-vite build** — compiles main/preload/renderer into `out/{main,preload,renderer}/`.
3. **rebuild:better-sqlite3:win** — `scripts/rebuild-sqlite3-win.ts` calls `prebuild-install` directly with `--platform=win32 --arch=x64 --runtime=electron --target=<version>` to download the prebuilt Windows `better_sqlite3.node`. Replaces the macOS binary in `node_modules/better-sqlite3/build/Release/` in place.
4. **electron-builder build --win** — packages everything into `out/Shorts AI Setup <version>.exe`.

Wall-clock: ~5-10 minutes after first-run caches are warm.

## Verifying

Before testing on a Windows machine, confirm the bundled native module is correct:

```bash
file node_modules/better-sqlite3/build/Release/better_sqlite3.node
# Expected: "PE32+ executable (DLL) ... for MS Windows"
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

- **No code signing.** SmartScreen warnings are expected on first run.
- **No auto-update.** Users have to download a new installer for each version.
- **ARM64 Windows not supported.** `mediapipe` doesn't publish arm64-windows wheels; cross-architecture support requires either a wheel becoming available or replacing the face detection backend.
- **Build artifact only — verification is manual.** No automated cross-platform CI. The Testing section of `docs/superpowers/specs/2026-05-11-windows-build-design.md` lists the manual VM checklist.
- **BtbN ffmpeg releases roll over.** The autobuild tag pinned in `scripts/runtime-versions.json` is dated; if a fresh `yarn fetch-runtime:win` ever 404s, update the URL to a newer `autobuild-YYYY-MM-DD-HH-mm` win64-gpl release and refresh the SHA via `shasum -a 256`.
