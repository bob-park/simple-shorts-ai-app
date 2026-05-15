# Windows STT Fix — Implementation Plan

> **⚠️ STATUS (2026-05-15): Phase 1 DONE & merged. Phase 2 done differently (via the shipped diagnostics + a systematic-debugging session). Phase 3 (Tasks 7–10) SUPERSEDED — disproven by evidence, do NOT execute. Phase 4 (Task 11) still valid.** See **Resolution** below for the two real root causes and the fixes actually applied. Task bodies are kept as the historical hypothesis space.

> **For agentic workers:** Phases 1–3 are complete/superseded — do not re-execute them. Only Phase 4 (Task 11, docs) and the Resolution's follow-ups remain. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make STT work on packaged Windows by first capturing the real `transcribe_failed` exception (via a permanent sidecar log + setup self-test), then applying the targeted runtime fix it points to.

**Architecture:** Phase 1 adds permanent diagnostics (a `<userData>/logs/sidecar.log` tee + a `SetupWizardService.selfTest()` gate) — unconditional, lands and commits first, needs no Windows. Phase 2 is a manual capture run on the user's Windows VM that classifies the root cause. Phase 3 applies exactly one fix branch (3a ctranslate2 MSVC++ runtime DLLs — primary; 3b HF cache; 3c device/PyAV) chosen by Phase 2. Phase 4 updates verification docs.

**Tech Stack:** Electron (main/preload/renderer, TypeScript), Python sidecar (`shorts_sidecar`), vitest (run under Electron's Node), electron-builder, `scripts/fetch-runtime.ts`.

**Spec:** `docs/superpowers/specs/2026-05-15-windows-stt-fix-design.md`

**Conventions:**
- Tests run with `yarn test` (vitest under Electron's Node) — never plain `node`/`vitest`.
- Single test file: `yarn test src/main/infra/SidecarLogger.test.ts`.
- Every code step shows the full code. Commit after every task.
- macOS behavior must stay byte-for-byte identical — all new Windows-only code paths are guarded.

---

## Resolution (2026-05-15)

**Phase 1 (Tasks 1–6) — DONE**, branch `fix-win-stt-diagnostics`, TDD + subagent-driven review: `SidecarLogger` `0052b1d`, PythonSidecar `logSink` `0c0837b`, `SetupWizardService.selfTest()` `7968e93`, main.ts/IPC wiring `322e876`, Settings affordance `eb0c6f9`. Full suite green, macOS unchanged.

**Phase 2 (Task 7) — done differently.** The capture happened through the shipped diagnostics, not the manual console procedure: the setup self-test **passed** on the user's Windows machine and `sidecar.log` carried the real evidence, read in a `/superpowers:systematic-debugging` session.

**Phase 3 (Tasks 8/9/10) — SUPERSEDED, not implemented.** Evidence disproved all branches:
- Task 8 / 3a (ctranslate2 MSVC++ vcredist bundling): the self-test (`import ctranslate2`) **passed** on Windows → no missing DLL. Obsolete.
- Task 9 / 3b (HF cache): the HF symlink line is a benign warning, not the failure. Not needed.
- Task 10 / 3c (device/PyAV): ctranslate2 loaded on CPU fine. Not the issue.

**Two real root causes were found and fixed instead (TDD, same branch):**

- **Problem A — macOS `setup:run` fails.** abetlen prebuilt CPU `py3-none-macosx_11_0_arm64` wheels for `llama-cpp-python` 0.3.21–0.3.23 are corrupt at the source (byte-exact download, fails zip/deflate extraction; 0.3.19 cp311 mac + 0.3.23 win wheels are valid). The `>=0.3.22` float selected the corrupt newest wheel. **Fix `3d24fba`:** pin `llama-cpp-python==0.3.19` (newest with valid wheels for mac-arm64 **and** win cp311; Gemma-3-capable). Guard: `src/main/services/sidecarRequirements.test.ts`.
- **Problem B — Windows STT "does nothing".** Not an STT bug (self-test passed; model downloaded; ctranslate2 loaded on CPU). The `starting` UI state — spanning sidecar boot + first-run multi-minute model **download** + load — showed a static "(최초 1회 수십 초 소요)" line with no liveness; the user judged it hung and killed the app, aborting a working transcribe (`sidecar shutting down`). **Fix `ea6a3b0`:** honest first-run model-prep copy (download, several minutes, don't close the window) + indeterminate progressbar. Guard: `tests/renderer/TranscribeCard.test.tsx`.

**Remaining valid follow-up:** Phase 4 / Task 11 — update `docs/build-windows.md` triage to reflect the real causes (the pin + the model-download UX), **not** the obsolete "classifier probe → 3a/3b/3c" flow.

---

## Phase 1 — Diagnostic Infrastructure (unconditional, lands first) — ✅ DONE (see Resolution)

### Task 1: `SidecarLogger` infra module

**Files:**
- Create: `src/main/infra/SidecarLogger.ts`
- Test: `src/main/infra/SidecarLogger.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/infra/SidecarLogger.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { SidecarLogger, type SidecarLoggerFs } from './SidecarLogger';

function makeFs() {
  const calls: { mkdir: string[]; write: [string, string][]; append: [string, string][] } = {
    mkdir: [],
    write: [],
    append: [],
  };
  const fs: SidecarLoggerFs = {
    mkdirSync: (p) => {
      calls.mkdir.push(p);
    },
    writeFileSync: (p, d) => {
      calls.write.push([p, d]);
    },
    appendFileSync: (p, d) => {
      calls.append.push([p, d]);
    },
  };
  return { fs, calls };
}

describe('SidecarLogger', () => {
  it('creates the log dir and truncates the file on construction', () => {
    const { fs, calls } = makeFs();
    new SidecarLogger('/data/logs/sidecar.log', fs);
    expect(calls.mkdir[0]).toBe('/data/logs');
    expect(calls.write).toEqual([['/data/logs/sidecar.log', '']]);
  });

  it('append() writes through to appendFileSync', () => {
    const { fs, calls } = makeFs();
    const log = new SidecarLogger('/data/logs/sidecar.log', fs);
    log.append('hello\n');
    expect(calls.append).toEqual([['/data/logs/sidecar.log', 'hello\n']]);
  });

  it('never throws when the underlying fs throws', () => {
    const fs: SidecarLoggerFs = {
      mkdirSync: () => {
        throw new Error('EACCES');
      },
      writeFileSync: () => {
        throw new Error('EACCES');
      },
      appendFileSync: () => {
        throw new Error('EACCES');
      },
    };
    const log = new SidecarLogger('/x/sidecar.log', fs);
    expect(() => log.append('data')).not.toThrow();
  });

  it('caps total bytes written and stops appending past the cap', () => {
    const { fs, calls } = makeFs();
    const log = new SidecarLogger('/data/logs/sidecar.log', fs, 10);
    log.append('1234567'); // 7 bytes
    log.append('89012345'); // would exceed 10 — sliced to remaining 3
    log.append('more'); // capped — ignored
    const totalAppended = calls.append.map(([, d]) => d).join('');
    expect(totalAppended).toBe('1234567' + '890');
  });

  it('exposes a bound sink function', () => {
    const { fs, calls } = makeFs();
    const log = new SidecarLogger('/data/logs/sidecar.log', fs);
    const sink = log.sink;
    sink('via-sink');
    expect(calls.append).toEqual([['/data/logs/sidecar.log', 'via-sink']]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/main/infra/SidecarLogger.test.ts`
Expected: FAIL — `Cannot find module './SidecarLogger'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/main/infra/SidecarLogger.ts`:

```ts
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SidecarLoggerFs {
  mkdirSync(path: string, opts?: { recursive: true }): void;
  writeFileSync(path: string, data: string): void;
  appendFileSync(path: string, data: string): void;
}

const NODE_FS: SidecarLoggerFs = {
  mkdirSync: (p, o) => void mkdirSync(p, o),
  writeFileSync: (p, d) => writeFileSync(p, d),
  appendFileSync: (p, d) => appendFileSync(p, d),
};

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Best-effort append-only sidecar log. Truncated on construction (one file
 * per app launch), byte-capped, and guaranteed never to throw — a logging
 * failure must not crash the app or break the pipeline.
 */
export class SidecarLogger {
  private written = 0;
  private capped = false;

  constructor(
    private readonly logPath: string,
    private readonly fs: SidecarLoggerFs = NODE_FS,
    private readonly maxBytes: number = DEFAULT_MAX_BYTES,
  ) {
    try {
      this.fs.mkdirSync(dirname(logPath), { recursive: true });
      this.fs.writeFileSync(logPath, '');
    } catch {
      /* best-effort */
    }
  }

  append(chunk: string): void {
    if (this.capped) return;
    try {
      const remaining = this.maxBytes - this.written;
      if (remaining <= 0) {
        this.capped = true;
        return;
      }
      const slice = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
      this.fs.appendFileSync(this.logPath, slice);
      this.written += slice.length;
    } catch {
      /* best-effort: never throw */
    }
  }

  get sink(): (chunk: string) => void {
    return (chunk: string) => this.append(chunk);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/main/infra/SidecarLogger.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/infra/SidecarLogger.ts src/main/infra/SidecarLogger.test.ts
git commit -m "feat(diag): best-effort byte-capped SidecarLogger"
```

---

### Task 2: Tee sidecar stderr into the logger via injected sink

**Files:**
- Modify: `src/main/infra/PythonSidecar.ts:10-16` (options interface), `:108-111` (stderr handler)
- Test: `src/main/infra/PythonSidecar.test.ts` (add one test)

- [ ] **Step 1: Write the failing test**

Add this test inside the `describe('PythonSidecar', …)` block in `src/main/infra/PythonSidecar.test.ts` (after the existing `routes progress notifications` test):

```ts
  it('tees stderr to the injected logSink as well as process.stderr', async () => {
    const logSink = vi.fn();
    const s = new PythonSidecar({
      spawn: spawn as never,
      command: 'uv',
      args: ['run'],
      cwd: '/tmp/sidecar',
      env: {},
      logSink,
    });
    void s.request<unknown>('health');
    (child.stdin as PassThrough).read();
    child.stderr.write(Buffer.from('boom traceback\n'));
    await new Promise((r) => setTimeout(r, 0));
    expect(logSink).toHaveBeenCalledWith('[sidecar] boom traceback\n');
    s.shutdown();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/main/infra/PythonSidecar.test.ts`
Expected: FAIL — `logSink` is not a valid option / not called.

- [ ] **Step 3: Write minimal implementation**

In `src/main/infra/PythonSidecar.ts`, extend the options interface (currently lines 10-16):

```ts
export interface PythonSidecarOptions {
  spawn: SpawnLike;
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Best-effort tee for sidecar stderr (diagnostics). */
  logSink?: (chunk: string) => void;
}
```

Replace the `child.stderr.on('data', …)` handler (currently lines 108-111) with:

```ts
    child.stderr.on('data', (chunk: Buffer) => {
      // Forward sidecar logs to our stderr for diagnostics.
      const line = `[sidecar] ${chunk}`;
      process.stderr.write(line);
      this.opts.logSink?.(line);
    });
```

- [ ] **Step 4: Run the full PythonSidecar suite**

Run: `yarn test src/main/infra/PythonSidecar.test.ts`
Expected: PASS (all existing tests + the new one).

- [ ] **Step 5: Commit**

```bash
git add src/main/infra/PythonSidecar.ts src/main/infra/PythonSidecar.test.ts
git commit -m "feat(diag): tee PythonSidecar stderr into injected logSink"
```

---

### Task 3: `SetupWizardService.selfTest()` + sentinel-aware `status()`

**Files:**
- Modify: `src/main/services/SetupWizardService.ts`
- Test: `src/main/services/SetupWizardService.test.ts`

The STT-runtime traceback (`from faster_whisper import …`) never reaches stderr — it returns as a JSON-RPC error mid-job. A self-test that imports the STT stack at setup time converts that into an explicit, named, setup-time failure and gates `status()` so a broken venv is not reported `ready`.

- [ ] **Step 1: Write the failing tests**

In `src/main/services/SetupWizardService.test.ts`, update the shared `opts`/`WIN_OPTS` and add tests. First, add `writeFile` to every `fs:` mock used by `run`-path tests by replacing the existing `fs: { access: vi.fn(async () => undefined) }` occurrences in the `describe('SetupWizardService.run', …)` block with:

```ts
      fs: { access: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined) },
```

Then, in every existing `svc.run()` test in that block, drive a **third** child (the self-test spawn) to exit 0 by adding, after the existing `children[1]` exit line and its awaited tick:

```ts
    await new Promise((r) => setImmediate(r));
    setImmediate(() => children[2]!.emit('exit', 0));
```

Add this new `describe` block at the end of the file:

```ts
describe('SetupWizardService.selfTest + status gating', () => {
  it('run() spawns the STT import probe with the venv python after pip install', async () => {
    const { spawn, children } = makeSpawn();
    const writeFile = vi.fn(async () => undefined);
    const svc = new SetupWizardService({
      ...opts,
      spawn,
      fs: { access: vi.fn(async () => undefined), writeFile },
    } as never);
    const promise = svc.run();
    setImmediate(() => children[0]!.emit('exit', 0));
    await new Promise((r) => setImmediate(r));
    setImmediate(() => children[1]!.emit('exit', 0));
    await new Promise((r) => setImmediate(r));
    setImmediate(() => children[2]!.emit('exit', 0));
    await promise;
    expect(spawn).toHaveBeenNthCalledWith(
      3,
      '/data/sidecar-venv/bin/python',
      ['-c', 'import faster_whisper, ctranslate2, av; print("stt-ok")'],
      expect.anything(),
    );
    expect(writeFile).toHaveBeenCalledWith('/data/sidecar-venv/.stt-selftest-ok', 'ok');
  });

  it('run() rejects with the probe stderr when the self-test fails (no sentinel written)', async () => {
    const { spawn, children } = makeSpawn();
    const writeFile = vi.fn(async () => undefined);
    const svc = new SetupWizardService({
      ...opts,
      spawn,
      fs: { access: vi.fn(async () => undefined), writeFile },
    } as never);
    const promise = svc.run();
    setImmediate(() => children[0]!.emit('exit', 0));
    await new Promise((r) => setImmediate(r));
    setImmediate(() => children[1]!.emit('exit', 0));
    await new Promise((r) => setImmediate(r));
    setImmediate(() => {
      children[2]!.stderr.emit('data', Buffer.from('ImportError: DLL load failed: ctranslate2'));
      children[2]!.emit('exit', 1);
    });
    await expect(promise).rejects.toThrow(/DLL load failed: ctranslate2/);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("status() is 'pending' when the venv exists but the self-test sentinel does not", async () => {
    const access = vi.fn(async (p: string) => {
      if (p === '/data/sidecar-venv/.stt-selftest-ok') throw new Error('ENOENT');
    });
    const svc = new SetupWizardService({
      ...opts,
      spawn: vi.fn(),
      fs: { access, writeFile: vi.fn(async () => undefined) },
    } as never);
    expect(await svc.status()).toBe('pending');
  });

  it("status() is 'ready' when both the venv python and the sentinel exist", async () => {
    const svc = new SetupWizardService({
      ...opts,
      spawn: vi.fn(),
      fs: { access: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined) },
    } as never);
    expect(await svc.status()).toBe('ready');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test src/main/services/SetupWizardService.test.ts`
Expected: FAIL — `selfTest` not invoked / `writeFile` undefined / sentinel not checked.

- [ ] **Step 3: Write minimal implementation**

In `src/main/services/SetupWizardService.ts`:

Add at the top with the other imports:

```ts
import { join } from 'node:path';
```

Replace the `FsLike` interface (currently lines 4-6) with:

```ts
interface FsLike {
  access: (path: string) => Promise<void>;
  writeFile: (path: string, data: string) => Promise<void>;
}
```

Change the private `spawnAndWait` phase parameter type from `'venv' | 'pip'` to `'venv' | 'pip' | 'selftest'` (the body already only special-cases `'pip'`, so no other change needed):

```ts
  private spawnAndWait(cmd: string, args: string[], phase: 'venv' | 'pip' | 'selftest'): Promise<void> {
```

Add a private getter for the sentinel path (place it just below the constructor):

```ts
  private get sentinelPath(): string {
    return join(this.opts.venvPath, '.stt-selftest-ok');
  }

  async selfTest(): Promise<void> {
    await this.spawnAndWait(
      this.opts.venvPythonBinary,
      ['-c', 'import faster_whisper, ctranslate2, av; print("stt-ok")'],
      'selftest',
    );
  }
```

Replace `status()` (currently lines 49-56) with:

```ts
  async status(): Promise<SetupStatus> {
    try {
      await this.opts.fs.access(this.opts.venvPythonBinary);
      await this.opts.fs.access(this.sentinelPath);
      return 'ready';
    } catch {
      return 'pending';
    }
  }
```

Append to the end of `run()` (after the existing `uv pip install` `spawnAndWait` call):

```ts
    await this.selfTest();
    await this.opts.fs.writeFile(this.sentinelPath, 'ok');
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test src/main/services/SetupWizardService.test.ts`
Expected: PASS (all existing + new tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/services/SetupWizardService.ts src/main/services/SetupWizardService.test.ts
git commit -m "feat(diag): setup self-test gate (import faster_whisper/ctranslate2/av) + sentinel-aware status"
```

---

### Task 4: Wire logger + log-folder IPC into `main.ts` and the API surface

**Files:**
- Modify: `src/shared/ipc.ts:87-89` (AppApi), `src/main/preload.ts:89-91`, `src/main/main.ts`

No new unit test (this is integration wiring of already-tested units); correctness is covered by `yarn typecheck` + the manual Windows run in Phase 2/4.

- [ ] **Step 1: Add the API method to the shared contract**

In `src/shared/ipc.ts`, add to the `AppApi` interface just below `openPath` (line 89):

```ts
  /** Reveal the sidecar log file in the OS file manager. */
  openLogsFolder(): Promise<void>;
```

- [ ] **Step 2: Implement it in preload**

In `src/main/preload.ts`, add to the `api` object just below the `openPath` line (line 90):

```ts
  openLogsFolder: () => ipcRenderer.invoke('logs:openFolder'),
```

- [ ] **Step 3: Wire the logger + IPC handler in main.ts**

In `src/main/main.ts`:

Add the import near the other infra imports (after the `PythonSidecar` import, line 18):

```ts
import { SidecarLogger } from './infra/SidecarLogger';
```

Add a lazy singleton accessor next to the other `getX()` factories (e.g. just above `getTranscribeService`, line 175):

```ts
let sidecarLogger: SidecarLogger | null = null;
function getSidecarLogger(): SidecarLogger {
  if (sidecarLogger) return sidecarLogger;
  sidecarLogger = new SidecarLogger(join(app.getPath('userData'), 'logs', 'sidecar.log'));
  return sidecarLogger;
}
function logSidecarFailure(stage: string, fileLabel: string, e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  getSidecarLogger().append(
    `[${new Date().toISOString()}] ${stage} failed (${fileLabel}): ${message}\n`,
  );
}
```

In `getTranscribeService()`, add `logSink` to the `new PythonSidecar({ … })` options (currently lines 179-185) so it reads:

```ts
  pythonSidecar = new PythonSidecar({
    spawn,
    command: paths.sidecarSpawn.command,
    args: paths.sidecarSpawn.args,
    cwd: paths.sidecarCwd,
    env: { HF_HOME: modelsDir, ...paths.sidecarEnv },
    logSink: getSidecarLogger().sink,
  });
```

In the `transcribe:run` handler `catch` block (currently lines 480-483), add the log call before `notifyStageComplete`:

```ts
    } catch (e) {
      logSidecarFailure('transcribe', fileLabel, e);
      notifyStageComplete('자막 추출 실패', `${fileLabel}: ${(e as Error).message}`);
      throw e;
    }
```

In the `extract:run` handler `catch` block (currently lines 543-545), add the same before its `notifyStageComplete`:

```ts
    } catch (e) {
      logSidecarFailure('extract', fileLabel, e);
      notifyStageComplete('하이라이트 추출 실패', `${fileLabel}: ${(e as Error).message}`);
      throw e;
```

Register the IPC handler next to the other `shell:` handlers (after the `shell:openPath` handler, ~line 497):

```ts
  ipcMain.handle('logs:openFolder', () => {
    shell.showItemInFolder(join(app.getPath('userData'), 'logs', 'sidecar.log'));
  });
```

Task 3 added a required `writeFile` to `FsLike`, so update the `SetupWizardService` construction in `getSetupWizard()` (currently ~line 308) — change `fs: { access: fsPromises.access }` to:

```ts
    fs: { access: fsPromises.access, writeFile: fsPromises.writeFile },
```

- [ ] **Step 4: Typecheck**

Run: `yarn typecheck`
Expected: PASS (no type errors).

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `yarn test`
Expected: PASS (entire suite green).

- [ ] **Step 6: Commit**

```bash
git add src/shared/ipc.ts src/main/preload.ts src/main/main.ts
git commit -m "feat(diag): wire SidecarLogger + logs:openFolder; log failed transcribe/extract"
```

---

### Task 5: "로그 폴더 열기" affordance in Settings

**Files:**
- Modify: `src/renderer/components/settings/PathsSection.tsx`

- [ ] **Step 1: Add the row**

Replace the contents of `src/renderer/components/settings/PathsSection.tsx` with (adds one `SettingsRow` with a button; everything else unchanged):

```tsx
import type { Settings } from '@shared/settings';

import { PathInput } from './PathInput';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';

export function PathsSection({
  paths,
  onChange,
}: {
  paths: Settings['paths'];
  onChange: (next: Settings['paths']) => void;
}) {
  return (
    <SettingsCard title="경로" description="다운로드한 원본·작업 파일·완성된 숏츠가 저장될 위치입니다.">
      <SettingsRow label="다운로드 폴더" hint="YouTube에서 받아온 원본 영상이 저장됩니다.">
        <PathInput
          value={paths.downloads}
          onChange={(downloads) => onChange({ ...paths, downloads })}
          dialogTitle="다운로드 폴더 선택"
        />
      </SettingsRow>
      <SettingsRow label="작업 폴더" hint="처리 중 임시 파일과 로그가 저장됩니다.">
        <PathInput
          value={paths.workspace}
          onChange={(workspace) => onChange({ ...paths, workspace })}
          dialogTitle="작업 폴더 선택"
        />
      </SettingsRow>
      <SettingsRow label="출력 폴더" hint="완성된 숏츠 영상이 저장됩니다.">
        <PathInput
          value={paths.outputs}
          onChange={(outputs) => onChange({ ...paths, outputs })}
          dialogTitle="출력 폴더 선택"
        />
      </SettingsRow>
      <SettingsRow label="진단 로그" hint="STT/사이드카 오류 진단용 로그 파일 위치입니다. 문제 보고 시 첨부하세요.">
        <button
          type="button"
          onClick={() => void window.api.openLogsFolder()}
          className="border-hairline px-lg text-button-md text-ink h-9 self-start rounded-full border"
        >
          로그 폴더 열기
        </button>
      </SettingsRow>
    </SettingsCard>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `yarn typecheck`
Expected: PASS (`window.api.openLogsFolder` is typed via Task 4's `AppApi` change).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/settings/PathsSection.tsx
git commit -m "feat(diag): 'open logs folder' affordance in Settings"
```

---

### Task 6: Phase 1 gate — full suite + lint + commit boundary

**Files:** none (verification only)

- [ ] **Step 1: Full verification**

Run: `yarn typecheck && yarn lint && yarn test`
Expected: all PASS. Phase 1 (permanent diagnostics) is complete and committed. **Do not start Phase 3 before Phase 2.**

---

## Phase 2 — Capture the Real Exception (manual, on the Windows VM) — ⚠️ SUPERSEDED

> Done differently — see **Resolution**. The shipped self-test + `sidecar.log` captured the evidence; the manual console procedure below was not needed. Kept as a fallback technique only.

### Task 7: Build the Windows installer, capture the classifier + traceback

**Files:** none (manual diagnostic; the output decides which Phase 3 task to run)

- [ ] **Step 1: Cross-build the Windows installer (macOS host)**

Run: `yarn package:win`
Expected: `out/Shorts AI Setup <version>.exe` produced. (See `docs/build-windows.md` if the better-sqlite3 / ffmpeg verification is needed.)

- [ ] **Step 2: Install on the Windows 10/11 x64 VM**

Copy the installer to the VM, install (default per-user path), launch once so first-run setup creates `%APPDATA%\Shorts AI\sidecar-venv\`. Note: with Task 3 merged, setup now also runs the self-test — **record whether setup itself fails here** and capture its message (that is the actionable error the gate was built for).

- [ ] **Step 3: 30-second classifier probe**

In a Windows shell:

```
"%APPDATA%\Shorts AI\sidecar-venv\Scripts\python.exe" -c "import ctranslate2; print(ctranslate2.__version__)"
```

Record the outcome:
- **Fails** with `ImportError` / `OSError: [WinError 126] … DLL load failed` → root cause = **Task 8 (3a)**. Skip Steps 4–5; go to Task 8.
- **Prints a version** → continue to Step 4.

- [ ] **Step 4: Drive the sidecar from the console**

From the install's `resources` directory (e.g. `%LOCALAPPDATA%\Programs\Shorts AI\resources`):

```
set PYTHONPATH=%CD%\sidecar-src
set HF_HOME=%APPDATA%\Shorts AI\whisper-models
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
"%APPDATA%\Shorts AI\sidecar-venv\Scripts\python.exe" -m shorts_sidecar
```

Paste one line (substitute a real downloaded file path; double the backslashes):

```
{"id":"1","method":"transcribe","params":{"audio_path":"C:\\Users\\<user>\\Downloads\\<file>.mp4","model":"small","language":"auto","device":"cpu"}}
```

- [ ] **Step 5: Classify the captured `transcribe_failed` traceback**

Also retrievable from `%APPDATA%\Shorts AI\logs\sidecar.log` (Settings → "로그 폴더 열기"). Map the exception to the fix branch:
- `huggingface_hub` / cache / symlink / `OSError` around the model cache dir → **Task 9 (3b)**
- `av` / PyAV / file-open / decode error on `audio_path` → **Task 10 (3c)**
- ctranslate2 DLL (if it surfaced here despite Step 3) → **Task 8 (3a)**

- [ ] **Step 6: Record the decision**

Write the captured exception + chosen branch into the plan's checklist (a comment in the PR / commit message). Proceed to exactly one of Task 8 / 9 / 10.

---

## Phase 3 — Targeted Fix (run EXACTLY ONE of Task 8 / 9 / 10, chosen by Task 7) — ⚠️ SUPERSEDED, DO NOT EXECUTE

> All three branches were disproven by evidence (see **Resolution**). The real fixes were Problem A (`3d24fba`, pin `llama-cpp-python==0.3.19`) and Problem B (`ea6a3b0`, honest first-run model-prep UI). Tasks 8/9/10 below are retained only as the historical hypothesis space.

### Task 8: (3a — primary) Bundle the MSVC++ runtime DLLs for the sidecar

**Cause:** the `ctranslate2` Windows wheel needs `msvcp140.dll`, `vcruntime140.dll`, `vcruntime140_1.dll`, `vcomp140.dll`; python-build-standalone ships only `vcruntime140*`. Without the VC++ Redistributable installed, `import ctranslate2` fails. Fix stays per-user / no-admin by shipping the loose redistributable DLLs and adding their directory to the DLL search path before any CUDA/STT import.

**Files:**
- Modify: `scripts/runtime-versions.json`, `scripts/fetch-runtime.ts`, `electron-builder.yml`, `src/main/infra/runtimePaths.ts`, `src/main/infra/runtimePaths.test.ts`, `sidecar/src/shorts_sidecar/__main__.py`

- [ ] **Step 1: Add the failing runtimePaths test**

In `src/main/infra/runtimePaths.test.ts`, inside the `'Windows packaged: …'` test, add these assertions at the end of that `it(...)` body:

```ts
    expect(r.vcredistDir).toBe(join(WIN_PACKAGED_CTX.resourcesPath, 'vcredist'));
    expect(r.sidecarEnv).toEqual({
      PYTHONPATH: join(WIN_PACKAGED_CTX.resourcesPath, 'sidecar-src'),
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      SHORTS_VCREDIST_DIR: join(WIN_PACKAGED_CTX.resourcesPath, 'vcredist'),
    });
```

And in the `'macOS packaged: …'` test add:

```ts
    expect(r.vcredistDir).toBe('');
```

- [ ] **Step 2: Run to verify it fails**

Run: `yarn test src/main/infra/runtimePaths.test.ts`
Expected: FAIL — `vcredistDir` undefined; `sidecarEnv` lacks `SHORTS_VCREDIST_DIR`.

- [ ] **Step 3: Implement runtimePaths**

In `src/main/infra/runtimePaths.ts`, add to the `RuntimePaths` interface (after `ffmpegBinary`):

```ts
  /**
   * Packaged Windows: directory holding the redistributable MSVC++ runtime
   * DLLs (msvcp140 / vcomp140 / vcruntime140*) added to the sidecar's DLL
   * search path. Empty string everywhere else.
   */
  vcredistDir: string;
```

In the **packaged Windows** branch only, set `vcredistDir` and add it to `sidecarEnv`. Replace the packaged return object's `sidecarEnv` block and add the field:

```ts
      ffmpegBinary: join(r, `ffmpeg${exe}`),
      vcredistDir: isWin ? join(r, 'vcredist') : '',
      ytdlpBinary: join(r, `yt-dlp${exe}`),
      sidecarCwd: r,
      venvPythonBinary,
      sidecarSpawn: { command: venvPythonBinary, args: ['-m', 'shorts_sidecar'] },
      sidecarEnv: {
        PYTHONPATH: join(r, 'sidecar-src'),
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        ...(isWin ? { SHORTS_VCREDIST_DIR: join(r, 'vcredist') } : {}),
      },
```

In the **dev** return object, add `vcredistDir: ''` (place it next to `ffmpegBinary`):

```ts
    vcredistDir: '',
```

- [ ] **Step 4: Run to verify runtimePaths passes**

Run: `yarn test src/main/infra/runtimePaths.test.ts`
Expected: PASS (all branches, mac unchanged).

- [ ] **Step 5: Pin the redistributable artifact**

The DLLs come from the **`microsoft.vc143.crt`-style VC++ runtime NuGet package** (a zip; redistributable per the VS redistributable license; SHA-pinnable; `unzip`-extractable — same tooling `fetch-runtime.ts` already uses for ffmpeg/uv). On the macOS host:

```bash
# Download the pinned VC++ runtime redist NuGet zip (x64 native runtimes).
curl -L -o /tmp/vcredist.zip \
  "https://www.nuget.org/api/v2/package/Microsoft.VC143.CRT.x64/14.40.33810"
shasum -a 256 /tmp/vcredist.zip
unzip -l /tmp/vcredist.zip | grep -i '\.dll'
```

Confirm the zip contains `runtimes/win-x64/native/{msvcp140.dll,vcruntime140.dll,vcruntime140_1.dll,vcomp140.dll,concrt140.dll}` (the exact subset to ship is at minimum what Task 7 proved missing — shipping all five is safe and what this plan does). Then add to `scripts/runtime-versions.json` a new top-level key:

```json
  "vcredist": {
    "version": "14.40.33810",
    "targets": {
      "win-x64": {
        "url": "https://www.nuget.org/api/v2/package/Microsoft.VC143.CRT.x64/14.40.33810",
        "sha256": "<paste the shasum -a 256 output from above>"
      }
    }
  }
```

(If that NuGet id/version 404s or the SHA cannot be reproduced, substitute the current `Microsoft.VC143.CRT.x64` package version from nuget.org and re-pin the SHA the same way — this mirrors the BtbN-ffmpeg re-pin note already in `docs/build-windows.md`.)

- [ ] **Step 6: Extend the fetch-runtime types + add the unpack step**

In `scripts/fetch-runtime.ts`:

Add `vcredist` to the `VERSIONS` cast type (the object literal around line 61):

```ts
const VERSIONS = JSON.parse(await readFile(join(ROOT, 'scripts', 'runtime-versions.json'), 'utf8')) as {
  python: Tool;
  uv: Tool;
  ffmpeg: Tool;
  ytdlp: Tool;
  vcredist: Tool;
};
```

Add an unpack helper next to `unpackFfmpeg`:

```ts
const VCREDIST_DLLS = [
  'msvcp140.dll',
  'vcruntime140.dll',
  'vcruntime140_1.dll',
  'vcomp140.dll',
  'concrt140.dll',
];

async function unpackVcredist(archivePath: string, destDir: string): Promise<void> {
  if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  const extractDir = join(CACHE_DIR, 'vcredist-extract-win-x64');
  if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  await spawn2('unzip', ['-q', '-o', archivePath, '-d', extractDir]);
  const nativeDir = join(extractDir, 'runtimes', 'win-x64', 'native');
  for (const dll of VCREDIST_DLLS) {
    const src = join(nativeDir, dll);
    if (existsSync(src)) await spawn2('cp', [src, join(destDir, dll)]);
  }
}
```

In `fetchTarget`, after the yt-dlp block and only for the Windows target, add:

```ts
  if (target === 'win-x64') {
    const vcMeta = VERSIONS.vcredist.targets[target];
    if (!vcMeta) throw new Error(`No vcredist entry for target ${target}`);
    const vcArchive = await ensureCached(
      vcMeta.url,
      vcMeta.sha256,
      `vcredist-${VERSIONS.vcredist.version}-${target}.zip`,
    );
    await unpackVcredist(vcArchive, join(archDir, 'vcredist'));
  }
```

- [ ] **Step 7: Bundle into the installer**

In `electron-builder.yml`, under `win:` `extraResources:` (after the `yt-dlp.exe` entry, line ~49), add:

```yaml
    - from: build-resources/win-x64/vcredist
      to: vcredist
```

- [ ] **Step 8: Add the DLL directory in the sidecar entrypoint**

In `sidecar/src/shorts_sidecar/__main__.py`, add a function next to `_add_nvidia_dll_directories` and call it on the line right after that function's existing call:

```python
def _add_vcredist_dll_directory() -> None:
    """Make the bundled MSVC++ runtime DLLs (msvcp140/vcomp140/vcruntime140*)
    discoverable before any ctranslate2 / llama_cpp import. python-build-
    standalone ships only vcruntime140*, so on a machine without the VC++
    Redistributable installed `import ctranslate2` fails with
    `OSError [WinError 126] ... DLL load failed`. The directory is bundled at
    <resources>/vcredist and passed in via SHORTS_VCREDIST_DIR. The is_dir
    guard makes this a no-op on macOS and on configs without the directory.
    """
    if sys.platform != "win32":
        return
    d = os.environ.get("SHORTS_VCREDIST_DIR")
    if d and Path(d).is_dir():
        os.add_dll_directory(d)


_add_nvidia_dll_directories()
_add_vcredist_dll_directory()
```

- [ ] **Step 9: Sidecar unit tests still green**

Run: `cd sidecar && uv run pytest -q && cd ..`
Expected: PASS (the new function is import-guarded; existing tests unaffected on macOS).

- [ ] **Step 10: Full JS suite + typecheck**

Run: `yarn typecheck && yarn test`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add scripts/runtime-versions.json scripts/fetch-runtime.ts electron-builder.yml \
  src/main/infra/runtimePaths.ts src/main/infra/runtimePaths.test.ts \
  sidecar/src/shorts_sidecar/__main__.py
git commit -m "fix(win): bundle MSVC++ runtime DLLs so ctranslate2 imports without VC++ redist"
```

- [ ] **Step 12: Rebuild + verify on the Windows VM**

Run: `yarn package:win`, reinstall on the VM, repeat Task 7 Step 3 (classifier now prints a version) and a full download → transcribe run. Expected: transcribe succeeds; `sidecar.log` shows a clean run.

---

### Task 9: (3b — contingency) Harden the HuggingFace model download/cache

Run only if Task 7 classified the failure as a HuggingFace cache/symlink/`OSError`.

**Files:**
- Modify: `src/main/infra/runtimePaths.ts` (add `HF_HUB_DISABLE_SYMLINKS_WARNING` to win `sidecarEnv`), `src/main/infra/runtimePaths.test.ts`, `src/main/main.ts` (ensure `HF_HOME` dir exists before sidecar use)

- [ ] **Step 1: Failing test**

In `src/main/infra/runtimePaths.test.ts` `'Windows packaged'` test, extend the `sidecarEnv` expectation to include:

```ts
      HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
```

- [ ] **Step 2: Verify fail**

Run: `yarn test src/main/infra/runtimePaths.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/main/infra/runtimePaths.ts`, in the packaged-Windows `sidecarEnv`, add (Windows only):

```ts
        ...(isWin ? { HF_HUB_DISABLE_SYMLINKS_WARNING: '1' } : {}),
```

In `src/main/main.ts` `getTranscribeService()`, before `new PythonSidecar(...)`, ensure the cache dir exists:

```ts
  const modelsDir = join(app.getPath('userData'), 'whisper-models');
  try {
    require('node:fs').mkdirSync(modelsDir, { recursive: true });
  } catch {
    /* best-effort */
  }
```

(If a hard symlink failure remains after this, escalate to the spec's 3b fallback: prefetch the Whisper model with a streaming downloader mirroring `LlmEngine.download_model` and pass the local path to `WhisperModel` — implement as a follow-up task scoped from the captured error.)

- [ ] **Step 4: Verify pass + suite**

Run: `yarn typecheck && yarn test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/infra/runtimePaths.ts src/main/infra/runtimePaths.test.ts src/main/main.ts
git commit -m "fix(win): silence HF symlink warning + ensure whisper cache dir exists"
```

- [ ] **Step 6: Rebuild + verify** — `yarn package:win`, reinstall, transcribe end-to-end on the VM.

---

### Task 10: (3c — contingency) device clamp + audio path normalization

Run only if Task 7 classified the failure as a CUDA/Metal device load (user-set device) or a PyAV file-open/decode error on the path.

**Files:**
- Modify: `src/main/main.ts` (transcribe device resolution + path normalization)
- Test: covered by the existing `main`-level behavior + manual VM run (no isolated unit for the inline IPC handler)

- [ ] **Step 1: Implement device clamp**

In `src/main/main.ts` `transcribe:run`, replace the device resolution (currently lines 468-470) with a Windows-wide clamp to `cpu` for any non-cpu value (the Windows build ships no GPU stack):

```ts
      const requestedDevice = settings.whisper.device;
      const device = process.platform === 'win32' && requestedDevice !== 'cpu' ? 'cpu' : requestedDevice;
```

- [ ] **Step 2: Normalize the audio path**

In the same handler, normalize `audioPath` before passing it on (defends against mixed separators / relative paths):

```ts
      const transcript = await service.transcribe(resolvePath(audioPath), {
```

(`resolvePath` is already imported in `main.ts` as `resolve as resolvePath`.)

- [ ] **Step 3: Typecheck + suite**

Run: `yarn typecheck && yarn test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/main.ts
git commit -m "fix(win): clamp non-cpu whisper device on win + normalize audio path"
```

- [ ] **Step 5: Rebuild + verify** — `yarn package:win`, reinstall, transcribe end-to-end on the VM.

---

## Phase 4 — Verification Docs

### Task 11: Update `docs/build-windows.md`

**Files:**
- Modify: `docs/build-windows.md`

- [ ] **Step 1: Add self-test + log to the Verifying section**

In `docs/build-windows.md`, in the "Verifying" numbered list, replace item 4 ("Launch Shorts AI. Confirm the Python sidecar boots…") with:

```markdown
4. Launch Shorts AI. First launch runs setup, which now ends with a **self-test** that imports the STT runtime (`faster_whisper`, `ctranslate2`, `av`). If setup completes without an error card, the STT stack loaded. If it fails, the setup screen shows the exact import error — capture it.
5. Open **Settings → 진단 로그 → "로그 폴더 열기"**. Confirm `%APPDATA%\Shorts AI\logs\sidecar.log` exists; after a transcribe attempt it holds the full sidecar stderr + any `transcribe_failed` traceback. Attach this file to any bug report.
```

Renumber the subsequent items (the old 4→6 render check, 5→7 uninstall).

- [ ] **Step 2: Add a "Diagnosing STT failures" subsection** *(content corrected post-investigation — the old "import ctranslate2 → vcredist / 3a/3b/3c" matrix was disproven; use the real triage below)*

Append before "## Known limitations":

```markdown
## Diagnosing STT failures

The shipped diagnostics make this concrete (do not guess):

1. **macOS setup fails — `uv exited 1 … deflate decompression error: invalid block type`.** An upstream abetlen `llama-cpp-python` CPU wheel is corrupt. We pin `llama-cpp-python==0.3.19` (last version with valid abetlen wheels for mac-arm64 + win, Gemma-3-capable; guarded by `sidecarRequirements.test.ts`). If it recurs: confirm the pin shipped; verify the pinned version's abetlen mac-arm64/win wheels still extract (download via the GitHub-releases href, `python -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).testzip()"`); re-pin to another version whose wheels are valid on both platforms; clear a stale `~/.cache/uv` if a corrupt wheel was cached before the pin.
2. **Windows STT "seems to do nothing".** Expected on first run: the Whisper model download (hundreds of MB to several GB) + load takes minutes and is now shown by the "전사 준비 중…" card with a liveness bar — wait it out, do not close the window. A *real* failure surfaces as a `자막 추출 실패` notification and a full traceback in `%APPDATA%\Shorts AI\logs\sidecar.log` (Settings → 진단 로그 → 로그 폴더 열기). `sidecar shutting down` in the log = the app/window was closed mid-transcribe, not an STT error. The setup self-test already gates `import faster_whisper, ctranslate2, av` at install time.

See the **Resolution** in `docs/superpowers/specs/2026-05-15-windows-stt-fix-design.md` for the evidenced root causes.
```

- [ ] **Step 3: Commit**

```bash
git add docs/build-windows.md
git commit -m "docs(win): self-test + sidecar.log verification and STT triage steps"
```

---

## Self-Review

**Spec coverage:**
- Goal 1 (capture exact exception) → Task 7.
- Goal 2 (permanent sidecar log + UI affordance) → Tasks 1, 2, 4, 5.
- Goal 3 (setup self-test gate, venv not `ready` on failure) → Task 3.
- Goal 4 (targeted fix) → Tasks 8/9/10 (one chosen by Task 7).
- Goal 5 (macOS unchanged) → all Windows paths guarded by `isWin` / `sys.platform` / `process.platform`; mac assertions kept in `runtimePaths.test.ts`; full `yarn test` gate in Tasks 6/8/9/10.
- Goal 6 (docs) → Task 11.
- Spec Phase 1/2/3 map → Plan Phase 1 (Tasks 1–6) / Phase 2 (Task 7) / Phase 3 (Tasks 8–10). Spec 3a/3b/3c → Tasks 8/9/10.

**Placeholder scan:** No "TBD/TODO". The only deferred value is the vcredist artifact SHA, which Task 8 Step 5 obtains with concrete commands and pins — the same pattern `docs/build-windows.md` already documents for BtbN ffmpeg. Task 9's deeper fallback is explicitly scoped as a conditional follow-up off the captured error, not a vague placeholder.

**Type consistency:** `SidecarLoggerFs`, `logSink?`, `selfTest()`, `sentinelPath`, `vcredistDir`, `SHORTS_VCREDIST_DIR`, `openLogsFolder()` are used identically across the tasks that define and consume them. `FsLike` gains `writeFile` consistently in Task 3 (interface + tests), and Task 4 Step 3 updates the only production constructor of `SetupWizardService` (`getSetupWizard()` in `main.ts`) to pass `writeFile: fsPromises.writeFile` — verified folded into the task body.

**Scope:** Single cohesive plan (diagnostics + one contained runtime fix). Not multiple independent subsystems. No decomposition needed.
```
