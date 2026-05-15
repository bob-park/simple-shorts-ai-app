# Windows STT Fix — Diagnostic Layer + Targeted Runtime Repair

**Status:** Spec, awaiting plan
**Date:** 2026-05-15
**Author:** Bob Park (with Claude)
**Scope:** Make STT (transcribe) work on packaged Windows. Add a permanent diagnostic layer (sidecar log file + setup self-test) so the real failure is captured instead of guessed, then apply the targeted runtime fix the captured exception points to. macOS behavior unchanged.

---

## Problem

On macOS the full pipeline works. On packaged Windows the installer + sidecar setup (`uv venv` + `uv pip install`) **succeed**, but the first `transcribe` call fails. The user-visible failure is a notification of the shape:

```
자막 추출 실패: transcribe_failed: <PythonExceptionType>: <message>
<traceback>
```

That shape is decisive. `transcribe_failed` is only produced at `sidecar/src/shorts_sidecar/server.py:147-156`, inside `_run_transcribe`, which runs on a worker thread **after** the sidecar has booted and the JSON-RPC handshake has succeeded. So this is **not** a spawn / venv-launch / import-time-crash / PATH problem. The sidecar process is alive and serving requests. The exception is raised inside `WhisperEngine.transcribe()` (`sidecar/src/shorts_sidecar/whisper_engine.py:69-101`), which on first use does:

1. `from faster_whisper import WhisperModel` (→ `import ctranslate2`) — lazy, via `_default_factory`
2. `WhisperModel(model, device=...)` — on first use downloads the model from HuggingFace into `HF_HOME`
3. `whisper.transcribe(audio_path, ...)` — PyAV-decodes the source media

The default `settings.whisper.device` is `'auto'`, which `src/main/main.ts:468-470` resolves to `'cpu'` on Windows, so the CUDA probe is **not** the cause for a default-settings user.

### Root-cause uncertainty is the actual blocker

The exact Python exception is unknown. The desktop notification truncates the traceback; the sidecar writes nothing to a log file; the `transcribe_failed` traceback travels back as a JSON-RPC `error` response (not stderr), so even `PythonSidecar`'s stderr tee would not capture it. The git history shows **10+ speculative `fix(win)` commits** (UTF-8 stdio, CUDA cublas/cudnn, device cpu-fallback, ffmpeg path escaping, DLL dirs, lazy `llama_cpp` import, cu124 revert). None converged because every fix was applied without the real error. Continuing to guess is the anti-pattern this spec exists to end.

## Goals

1. Capture the exact `transcribe_failed` Python exception (type, message, full traceback) from the user's Windows machine, with no further guessing.
2. A permanent sidecar log file at `<userData>/logs/sidecar.log` that records stderr **and** the full failure traceback from failed `transcribe`/`extract` IPC handlers, with a user-facing affordance to open it.
3. A setup-time self-test that probes the STT runtime (`import faster_whisper, ctranslate2, av`) immediately after `uv pip install`, surfacing an actionable error at setup time instead of a generic mid-job `transcribe_failed`. The venv is not marked `ready` if the self-test fails.
4. The targeted fix for the captured root cause applied so a default-settings packaged Windows install completes transcribe end-to-end.
5. macOS (dev and packaged) behavior is byte-for-byte unchanged.
6. `docs/build-windows.md` updated with the self-test + log-inspection verification steps.

## Non-Goals

- Cross-platform CI / automated Windows tests. Windows correctness is still verified by hand in a VM; unit tests cover the new JS-side logic only.
- LLM GPU acceleration / CUDA Whisper on Windows. Out of scope; CPU is the supported Windows path (unchanged).
- Code signing, auto-update, ARM64 Windows. Unchanged limitations.
- Reworking the JSON-RPC protocol or the sidecar threading model.
- Unrelated refactoring of the runtime-path or setup code beyond what the fix requires.

---

## Architecture

Three phases. Phases 1 and 2 are unconditional and land first. Phase 3 branches on the exception captured in Phase 2 — the spec defines all three contingencies so implementation is never blocked, but the implementation plan applies only the matching branch.

```
Phase 1  Diagnostic infra (permanent, lands first, no Windows needed to build)
   ├─ <userData>/logs/sidecar.log  ← PythonSidecar stderr tee + failed-handler traceback
   ├─ "로그 폴더 열기" affordance (shell.showItemInFolder)
   └─ SetupWizardService.selfTest()  ← import probe gate after uv pip install

Phase 2  Capture the real exception (uses the user's Windows machine)
   ├─ 30s classifier probe: python -c "import ctranslate2"
   └─ if needed: drive sidecar from console, feed one transcribe JSON line,
      read full traceback (commands enumerated in this spec)

Phase 3  Targeted fix (apply only the branch the captured error selects)
   ├─ 3a  ctranslate2 runtime DLL missing  (primary, highest probability)
   ├─ 3b  HuggingFace model download / cache path
   └─ 3c  device clamp / PyAV path normalization
```

### Phase 1 — Diagnostic infrastructure

**1a. Sidecar log file**

- Path: `join(app.getPath('userData'), 'logs', 'sidecar.log')`. Directory created on demand. Truncated on each app launch. Size cap ~2 MB (stop appending past the cap; never throw — all log writes are best-effort and a write failure must not crash the app or break the pipeline).
- `PythonSidecar` gains an optional injected sink: `logSink?: (chunk: string) => void`. The existing `child.stderr → process.stderr.write('[sidecar] …')` behavior is preserved; the sink is teed alongside it. Keeping it an injected function (not a file path inside `PythonSidecar`) preserves the class's purity and testability.
- The `transcribe_failed` / `extract` failure traceback arrives as a rejected `Error` in the IPC handlers (`src/main/main.ts` `transcribe:run`, `extract:run`), not on stderr. So those `catch` blocks append the full `(e as Error).message` (which already contains `code: message\n<traceback>` from `server.py`) to the same log via a small shared logger module before calling `notifyStageComplete`.
- User-facing affordance: a "로그 폴더 열기" action (e.g. on the Settings page and/or wired so a failure path can reveal it) calling `shell.showItemInFolder(logPath)`. Exact placement decided in the plan; requirement is that the log is reachable from the UI without a filesystem hunt.

**1b. Setup self-test (regression gate)**

- New method `SetupWizardService.selfTest(): Promise<void>` (or a result type carrying stderr). After the existing `uv pip install` step in `run()`, spawn the venv python with a probe equivalent to `python -c "import faster_whisper, ctranslate2, av; print('stt-ok')"`.
- On non-zero exit: do **not** let `status()` report `ready`. Surface the probe's captured stderr to the setup UI as an actionable message (`STT 런타임 로드 실패: <stderr 요약>`) and write the full stderr to `sidecar.log`.
- Spawn is dependency-injected exactly as the existing `run()` spawn is, so vitest covers both success and failure without a real Python.
- Rationale: converts a silent, generic, mid-job `transcribe_failed` into an explicit, named, setup-time diagnosis. This is the permanent guard that ends the blind-fix cycle.

### Phase 2 — Capture the real exception

Run on the user's Windows machine **before** writing any Phase 3 code.

**Step 1 — 30-second classifier probe.** From a Windows shell:

```
"%APPDATA%\Shorts AI\sidecar-venv\Scripts\python.exe" -c "import ctranslate2; print(ctranslate2.__version__)"
```

- Fails with `ImportError` / `OSError: [WinError 126] … DLL load failed` → root cause = **Phase 3a** (ctranslate2 runtime DLL). Stop here; go to 3a.
- Prints a version → ctranslate2 imports fine; the failure is later. Continue to Step 2.

**Step 2 — Drive the sidecar from the console** (only if Step 1 passed). From `<install>\resources`:

```
set PYTHONPATH=%CD%\sidecar-src
set HF_HOME=%APPDATA%\Shorts AI\whisper-models
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
"%APPDATA%\Shorts AI\sidecar-venv\Scripts\python.exe" -m shorts_sidecar
```

Then paste exactly one line (real downloaded path substituted, backslashes doubled for JSON):

```
{"id":"1","method":"transcribe","params":{"audio_path":"C:\\Users\\<user>\\Downloads\\<file>.mp4","model":"small","language":"auto","device":"cpu"}}
```

Read the full `transcribe_failed` traceback printed back as the JSON-RPC error. The exception type selects the Phase 3 branch:

- `WhisperModel(...)` / HF / `huggingface_hub` / network / symlink / `OSError` around the cache dir → **Phase 3b**
- PyAV / `av` / file-open / decode error on `audio_path` → **Phase 3c** (PyAV part)

### Phase 3 — Targeted fix

#### 3a. ctranslate2 runtime DLL missing (primary)

**Cause.** The `ctranslate2` Windows wheel (pulled in by `faster-whisper`) requires the MSVC++ 2019+ runtime — `msvcp140.dll`, `vcruntime140.dll`, `vcruntime140_1.dll` — and Microsoft OpenMP `vcomp140.dll`. python-build-standalone's Windows distribution ships `vcruntime140*` but not `msvcp140.dll` / `vcomp140.dll`. On a Windows machine without the "Visual C++ Redistributable" installed, `import ctranslate2` fails with `OSError [WinError 126] … DLL load failed`. macOS is unaffected (different binaries, no MSVC runtime concept).

**Fix (per-user, no admin — preserves the app's no-elevation install model).**

- `scripts/fetch-runtime.ts`: add a step that obtains the redistributable runtime DLLs for `win-x64` into `build-resources/win-x64/vcredist/`. Source must be a redistributable-licensed origin with a pinned SHA-256, following the existing `runtime-versions.json` + SHA-verify pattern. (Candidate source confirmed during implementation; the exact set of DLLs to ship is whatever the Phase 2 probe proves missing, at minimum `msvcp140.dll` + `vcomp140.dll`.)
- `electron-builder.yml`: add a `win.extraResources` entry copying `build-resources/win-x64/vcredist` → `<resources>/vcredist`.
- `src/main/infra/runtimePaths.ts`: add a `vcredistDir` field to `RuntimePaths` (packaged-win = `join(r, 'vcredist')`; empty string elsewhere). Surface it to the sidecar by adding `SHORTS_VCREDIST_DIR=<vcredistDir>` to `sidecarEnv` — the same mechanism already used for `PYTHONPATH` / `PYTHONUTF8`. Empty value when not packaged-win means the env var is simply unset/blank there.
- `sidecar/src/shorts_sidecar/__main__.py`: at the very top — before any `faster_whisper` / `ctranslate2` / `llama_cpp` import, next to the existing `_add_nvidia_dll_directories()` — read `os.environ.get("SHORTS_VCREDIST_DIR")` and, if it points to an existing directory (`Path.is_dir()` guard), call `os.add_dll_directory()` on it. The guard makes this a no-op on macOS and on configs without the directory.

**Rejected alternative.** Bundling `vc_redist.x64.exe` and running it during setup: it requires elevation, violating the per-user / no-admin install model (`electron-builder.yml` `nsis.allowElevation: false`). Not adopted.

#### 3b. HuggingFace model download / cache (contingency, if Step 1 passed)

- Ensure `HF_HOME` directory exists before the sidecar spawns (mkdir in the IPC path or setup).
- Set `HF_HUB_DISABLE_SYMLINKS_WARNING=1` in `sidecarEnv` (Windows lacks unprivileged symlinks; `huggingface-hub==0.26.5` already copy-falls-back, this silences the noise and avoids a symlink hard-failure path).
- If the captured error is a hard cache/symlink failure rather than a warning: download the Whisper model with our own streaming downloader (mirror `LlmEngine.download_model`'s staging-dir + atomic-rename pattern) into a stable directory and pass that **local path** to `WhisperModel(...)`, removing the dependency on huggingface_hub's symlinked cache layout entirely.

#### 3c. device clamp / PyAV path (contingency, low probability)

- device: if the captured error is a CUDA/Metal load on a user who manually set `settings.whisper.device` to `'cuda'`/`'metal'` on Windows, clamp non-`cpu` to `'cpu'` on `win32` with a logged, user-visible note (the default-`auto` case is already handled at `main.ts:468-470`).
- PyAV: normalize `audioPath` via `path.resolve` before handing it to the sidecar (defends against relative paths / mixed separators), if the captured error is a file-open/decode failure on the path.

---

## Error handling

- Self-test failure → `SetupWizardService.status()` must not return `ready`; the setup UI shows the probe stderr; full stderr written to `sidecar.log`.
- Log writes are best-effort: a failed/again-failing log write must never throw into the pipeline or crash the app. Truncate-on-launch + size cap prevent unbounded growth.
- Non-ASCII paths remain covered by the existing `PYTHONUTF8` / `PYTHONIOENCODING` env (unchanged).
- Phase 3a `os.add_dll_directory` is `is_dir`-guarded → no-op when the directory is absent (macOS, CPU-only configs) so it cannot regress mac.

## Testing

**Unit (vitest, runs on macOS):**
- `PythonSidecar`: stderr is teed to the injected `logSink` as well as `process.stderr`; absence of a sink is a no-op.
- `SetupWizardService.selfTest()`: injected spawn exit 0 → resolves / `status()` may be `ready`; non-zero → rejects/reports with captured stderr and `status()` not `ready`.
- `transcribe:run` / `extract:run` failure path appends the full error message to the logger.
- `runtimePaths`: packaged-win includes `vcredistDir = <resources>/vcredist`; macOS and dev unchanged (extend existing `runtimePaths.test.ts`).

**Manual (Windows 10/11 x64 VM, per `docs/build-windows.md`):**
- Phase 2 classifier probe result recorded.
- After fix: fresh install → setup self-test passes → download a short YouTube video → transcribe succeeds → highlights → render (libass regression check unchanged).
- `sidecar.log` contains the pre-fix traceback and, post-fix, a clean run.

**Docs:**
- `docs/build-windows.md` "Verifying" section gains the self-test expectation and the `sidecar.log` location/inspection step.

## Scope check

Single implementation plan. Phase 1 + 2 + the one selected Phase 3 branch. Not a new feature — a diagnostic layer plus a contained Windows runtime repair. No unrelated refactors. macOS path untouched.
