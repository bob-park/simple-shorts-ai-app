# M12 — Packaging & Distribution (macOS) Design Spec

**Status:** Drafted 2026-05-10, deferred to M12. Originally drafted as M11 right after the segment-based-highlights work, then bumped a second time when LLM-local was inserted as M11. This spec stays as-is for M12 execution; only the milestone number was renamed.

**Why:** M1–M10 produced a working dev-mode app. M12 turns it into a `.app` users can install from a `.dmg`. Scope is intentionally narrow: macOS only (Apple Silicon + Intel), no code signing, embedded Python with first-run deps install, bundled ffmpeg.

**Outcome:** `yarn package` produces two `.dmg` files. A first-run flow installs Python deps into `~/Library/Application Support/Shorts AI/sidecar-venv/`. Subsequent launches skip straight to the new-job UI.

---

## 1. Architecture

### 1.1 Bundle layout

```
/Applications/Shorts AI.app/
├── Contents/
│   ├── Info.plist
│   ├── MacOS/Shorts AI                       # Electron main binary
│   └── Resources/
│       ├── app.asar                          # JS bundle (renderer + main + preload)
│       ├── ffmpeg                            # bundled ffmpeg with libass (Universal binary)
│       ├── uv                                # uv standalone binary
│       └── python-runtime/                   # python-build-standalone unpack
│           ├── bin/python3.11
│           └── lib/python3.11/...
```

The three new "extraResources" entries (`ffmpeg`, `uv`, `python-runtime/`) are downloaded by a postinstall script into `build-resources/` at install/CI time, then bundled by electron-builder.

### 1.2 Runtime flow

**On every launch** (`main.ts` boot):

```
1. Resolve sidecar venv path:
   - If `process.resourcesPath`/`python-runtime` exists (packaged app):
       venvPath = `~/Library/Application Support/Shorts AI/sidecar-venv`
       pythonRuntime = `process.resourcesPath/python-runtime/bin/python3.11`
       uvBinary = `process.resourcesPath/uv`
   - Else (dev mode):
       venvPath = `<repo>/sidecar/.venv`
       pythonRuntime = system `python3.11`
       uvBinary = system `uv`
2. If venvPath/bin/python exists → boot main UI normally.
3. Else → push `/setup` onto router; UI shows SetupCard.
```

**Setup flow:**

```
SetupCard → IPC `setup:run`
→ SetupWizardService.run():
    a. quarantine-strip: `xattr -dr com.apple.quarantine <python-runtime>`
       (silently ignored if attribute not present)
    b. spawn uv: `uv venv <venvPath> --python <pythonRuntime>`
    c. spawn uv: `uv pip install --python <venvPath>/bin/python -r <bundled requirements.txt>`
       — stream stdout, parse progress lines, emit `setup:progress` events
    d. resolve when pip exits 0 (or reject on non-zero)
→ Renderer navigates back to '/'
```

**ffmpeg path resolution** (`FfmpegRunner.ts`):

```
1. If `process.resourcesPath`/`ffmpeg` exists → use it.
2. Else → fall back to system PATH lookup (current dev behavior).
```

### 1.3 What stays the same

- All M1–M10 service code (HighlightService, RenderService, HistoryService, etc.) is unchanged.
- IPC contract is unchanged except for the two new `setup:*` channels.
- Settings, History, NewJob pages are unchanged.

---

## 2. Build pipeline

### 2.1 `yarn package`

Pipeline:

```
yarn package
  → vite build (existing)
  → electron-builder build --mac dmg
      • reads electron-builder.yml
      • copies build-resources/{ffmpeg,uv,python-runtime} → Resources/
      • asar packs the JS bundle
      • produces:
          out/Shorts AI-0.1.0-arm64.dmg
          out/Shorts AI-0.1.0-x64.dmg
```

### 2.2 Pre-build resource fetching

A new script `scripts/fetch-runtime.ts` is run via `prepackage` npm hook. It:

1. Downloads (with caching by version+arch under `build-resources/.cache/`):
   - **python-build-standalone** Python 3.11 macOS Universal2 — from `https://github.com/astral-sh/python-build-standalone/releases`
   - **uv** macOS arm64 + x86_64 standalone — from `https://github.com/astral-sh/uv/releases`
   - **ffmpeg** static macOS arm64 + x86_64 with libass — from `https://www.osxexperts.net/` or `https://evermeet.cx/ffmpeg/` (chosen at implementation time based on libass availability)
2. Verifies SHA-256 against pinned hashes in `scripts/runtime-versions.json`
3. Unpacks into `build-resources/{arm64,x64}/{python-runtime,uv,ffmpeg}` per architecture

electron-builder picks the right arch's resources for each .dmg via the `extraResources` glob pattern.

### 2.3 `electron-builder.yml`

```yaml
appId: com.bobpark.shorts-ai
productName: Shorts AI
directories:
  output: out
files:
  - out/main/**
  - out/preload/**
  - out/renderer/**
  - package.json
  - '!**/*.test.*'
  - '!**/__tests__/**'
mac:
  category: public.app-category.video
  target:
    - target: dmg
      arch: [arm64, x64]
  identity: null  # explicit no-sign
  hardenedRuntime: false
extraResources:
  - from: build-resources/${arch}/python-runtime
    to: python-runtime
  - from: build-resources/${arch}/uv
    to: uv
  - from: build-resources/${arch}/ffmpeg
    to: ffmpeg
  - from: sidecar/requirements.txt
    to: requirements.txt
```

### 2.4 Sidecar requirements file

A new `sidecar/requirements.txt` (or pinned subset of `pyproject.toml`) lists the exact deps needed at runtime:

```
faster-whisper>=1.0.3
mediapipe>=0.10.18
opencv-python>=4.10
llama-cpp-python>=0.3.22
huggingface-hub==0.26.5
```

Mirrors `sidecar/pyproject.toml` (added in M11). `llama-cpp-python` is the heaviest single dep (~100MB + native build) — first-run setup is closer to 3-5 minutes than 1-3 minutes. The setup wizard's progress copy should reflect this.

Note: this file is read by the packaged app's setup wizard, NOT by uv during dev (`uv sync` reads `pyproject.toml` directly). The two are kept in sync manually; if a future task adds a new sidecar dep, both files need updating.

---

## 3. UI changes

### 3.1 New `/setup` route

A new top-level route, **outside the normal sidebar**. The router redirects to `/setup` if the venv doesn't exist; the sidebar is hidden during setup.

`src/renderer/pages/Setup.tsx` shows a single SetupCard with three discriminated states:

- `idle` — title + 1-line explanation + "설치 시작" button
- `running` — progress bar + step label ("Python 환경 만들기...", "패키지 설치 중 (1/3)...")
- `error` — error message + "다시 시도" button

When complete, the page navigates to `/` and the sidebar reappears on next render (because the router-level redirect now sees the venv exists).

### 3.2 Sidebar update

Sidebar is unchanged in markup — it's just suppressed by the AppShell when on `/setup`.

### 3.3 Settings page note (optional)

Settings page may show a small "사이드카 환경" section indicating whether venv exists and a "재설치" button. **Out of scope for M12** — only ship if it falls out of the wizard plumbing for free.

---

## 4. IPC contract additions

```ts
// preload bridge
window.api.setup = {
  status: () => Promise<'pending' | 'ready' | 'failed'>;  // checks venvPath/bin/python existence
  run: () => Promise<void>;  // long-running; resolves on success, rejects on failure
};

// progress events (streamed via IpcRenderer)
window.api.onSetupProgress: (cb: (event: SetupProgress) => void) => () => void;

type SetupProgress =
  | { phase: 'venv'; pct: 0 }
  | { phase: 'pip'; current: number; total: number; pct: number; currentPackage?: string };
```

The pip stdout is parsed for lines like `Resolved 23 packages`, `Building wheel for X`, `Installed X-Y` to drive the progress bar. If parsing fails, fall back to indeterminate spinner — non-fatal.

---

## 5. Failure handling

| Failure | UX |
|---|---|
| Network error during pip install | SetupCard 'error' state with stderr tail + "다시 시도" |
| `uv venv` exits non-zero | Same |
| User quits app mid-install | Next launch sees incomplete venv → re-detect: if `bin/python` missing, treat as never-installed |
| Disk full | pip stderr surfaces; user sees the error |
| `python-runtime` quarantined and Gatekeeper blocks dylib loading | xattr-strip step in 1.2 prevents this; if it still happens, error message includes "macOS 보안 설정 확인" hint |

The wizard does **not** auto-cleanup partial installs. Re-running setup overwrites in place; if venv is corrupt, user can manually delete `~/Library/Application Support/Shorts AI/sidecar-venv` and re-run setup.

---

## 6. Testing strategy

### 6.1 Unit tests

| File | Cases |
|---|---|
| `SetupWizardService.test.ts` (new) | venv exists detection, run() spawns uv with correct args, pip progress parsing (3 cases), error propagation |
| `PythonSidecar.test.ts` | (update) venv path resolution: packaged vs dev mode (2 new cases) |
| `FfmpegRunner.test.ts` | (update) bundled ffmpeg path takes precedence over PATH (2 new cases) |
| `Setup.test.tsx` (new) | renders all three states, click "재시도" calls api.setup.run, progress event updates pct |

Net ~10 new test cases. Total target: ~190 vitest pass.

### 6.2 Manual integration

After `yarn package`, on a clean macOS user account:

1. Mount `Shorts AI-0.1.0-arm64.dmg`, drag to /Applications.
2. Right-click → Open (Gatekeeper bypass on first run).
3. Verify SetupCard appears, progress streams, completes in 2-3 min.
4. Verify normal app flow works (download → STT → highlight → render).
5. Quit and re-open: setup is skipped, main UI loads immediately.
6. Verify bundled ffmpeg used (no `which ffmpeg` dependency — test by temporarily moving system ffmpeg).
7. Repeat on Intel Mac for x64 .dmg.

Manual checks are explicit in the plan's DoD; not automated in M12.

### 6.3 What's NOT tested in M12

- Actual `electron-builder` invocation in CI (manual `yarn package` only).
- macOS notarization (no signing).
- Windows packaging (M12).
- Auto-update (out of scope).

---

## 7. Migration

**N/A.** This is the first packaged release. Existing dev-mode users continue running `yarn dev`.

If a user has an existing `~/Library/Application Support/Shorts AI/` directory with a stored API key (keytar) or settings (electron-store), the packaged app reads/writes the same paths — settings/keys carry over.

---

## 8. Risk + edge cases

| Risk | Mitigation |
|---|---|
| python-build-standalone Universal2 binary requires both arches present at runtime | Use per-arch unpack; arm64 dmg gets arm64 python, x64 dmg gets x86_64 python |
| mediapipe wheel availability for Apple Silicon | Verified at brainstorming time: PyPI has `mediapipe-0.10.18-cp311-cp311-macosx_11_0_universal2.whl` |
| Gatekeeper blocks dylib loading from unsigned bundle | xattr-strip step + "right-click → Open" instructions in README |
| .app size approaches 200MB before deps install | Acceptable; users see ~50MB DMG, expand on disk |
| pip install fails partway, leaves broken venv | Detection logic checks `bin/python` existence (not just dir); failed install leaves no `bin/python` so re-run is safe |
| User on macOS 11 (below targeted macOS 12) | electron-builder's mac.minimumSystemVersion = "12.0" enforces; older macOS shows "App requires macOS 12.0 or later" |
| ffmpeg static binary's libass version mismatch with .ass features | Test against representative .ass output before pinning the ffmpeg source |
| Bundled uv/Python adds ~80MB to .dmg | Accept; it's the cost of "embedded runtime" choice |

---

## 9. Definition of Done (M12)

1. `yarn package` exits 0 and produces both `.dmg` files in `out/`.
2. Right-click → Open works on a clean macOS user account; SetupCard appears.
3. After setup completes, a fresh download → STT → highlight → render → history flow works end-to-end inside the .app.
4. Bundled ffmpeg is used (libass available); subtitle burn-in works without "No such filter: 'subtitles'" error.
5. `yarn typecheck`, `yarn lint`, `yarn test` (all ~190 cases) green.
6. Branch `m11-packaging` merged to master with `--no-ff` and tagged `m11-complete`.
7. README updated with installation instructions ("Right-click → Open on first launch").

---

## 10. What's NOT in M12 (intentionally deferred)

- **Windows packaging** (.exe / .msi) → M12
- **Code signing + notarization** (Apple Developer ID) → M12 or separate
- **Auto-update** (electron-updater) → out of v1
- **Mac App Store distribution**
- **Custom app icon design** (placeholder PNG only — final icon swap is a future polish task)
- **Settings → "사이드카 환경" management section** (재설치 button) → future polish
- **Whisper model pre-download** in setup wizard (lazy on first STT call as today)
- **Per-arch CI build automation** (manual `yarn package` only)

---

## 11. Notes for the implementing agent

- electron-builder picks up `electron-builder.yml` (or `.json`) automatically; no `package.json` `build:` block needed.
- `process.resourcesPath` is the canonical way to find Resources at runtime: in dev it's `node_modules/electron/dist/Electron.app/Contents/Resources`, in packaged it's `<App>.app/Contents/Resources`. The venv-detection logic should specifically check for `<resourcesPath>/python-runtime/bin/python3.11` to discriminate packaged vs dev (in dev that path won't exist).
- `xattr -dr com.apple.quarantine` is silent on missing attribute. Run it as `child_process.spawn` not shell — paths may have spaces.
- `uv pip install`'s stdout format may shift across versions; the progress parser must degrade gracefully (indeterminate spinner) on unexpected output.
- `path.join(process.resourcesPath, 'ffmpeg')` is the bundled path; use `existsSync` for the dev fallback check rather than `which`.
- For the dev fallback to keep working unchanged, do NOT add the bundled-path lookup to the dev test fixtures — gate it on `app.isPackaged`.
