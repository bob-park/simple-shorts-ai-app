# M2: Settings Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder Settings page with a fully working 5-section card layout that persists user preferences via `electron-store` and stores the OpenRouter API key encrypted via Electron's built-in `safeStorage`. Path inputs trigger native folder dialogs. The renderer talks to main exclusively through a typed IPC bridge.

**Architecture:** Main process owns persistence (`SettingsStore` over electron-store, `SecureStorage` over safeStorage) and exposes an IPC API. Renderer reads/writes via two hooks (`useSettings`, `useApiKey`) that wrap `window.api`. Settings UI is composed of one shared `SettingsCard` chrome plus five focused section components. All values flow through a zod-validated schema defined in `src/shared/settings.ts`, which both processes import.

**Tech Stack:** Electron 33+ `safeStorage`, electron-store 10+ (ESM), zod 3+, React 18 hooks, Tailwind v4 utility classes (MiniMax tokens already in `global.css`).

**Spec deviation (intentional):** The design spec (section 6.2) names `keytar` for the API key, but Electron's built-in `safeStorage` provides the same OS-keychain-backed encryption without a native module + electron-rebuild step. We use safeStorage and document this as the implementation choice. Functional behavior (encrypted at rest in OS keystore) is preserved.

---

## File Structure

```
src/
├── shared/
│   ├── ipc.ts                         # MODIFY: extend AppApi with settings/key/dialog methods
│   └── settings.ts                    # NEW: Settings interface + zod schema + DEFAULT_SETTINGS
├── main/
│   ├── main.ts                        # MODIFY: register new IPC handlers, wire stores
│   ├── preload.ts                     # MODIFY: expose new methods on window.api
│   └── infra/
│       ├── SettingsStore.ts           # NEW: electron-store wrapper, schema-validated read/write
│       ├── SettingsStore.test.ts      # NEW: unit tests
│       ├── SecureStorage.ts           # NEW: safeStorage wrapper, encrypt/decrypt API key
│       └── SecureStorage.test.ts      # NEW: unit tests
└── renderer/
    ├── hooks/
    │   ├── useSettings.ts             # NEW: load/update settings via IPC
    │   └── useApiKey.ts               # NEW: get/set/clear API key via IPC
    ├── components/
    │   └── settings/
    │       ├── SettingsCard.tsx       # NEW: MiniMax white-card chrome wrapper
    │       ├── SettingsRow.tsx        # NEW: label + control row
    │       ├── PathInput.tsx          # NEW: text + "찾아보기" button (folder dialog)
    │       ├── PasswordInput.tsx      # NEW: API key input with show/hide toggle
    │       ├── ApiModelSection.tsx    # NEW
    │       ├── PathsSection.tsx       # NEW
    │       ├── WhisperSection.tsx     # NEW
    │       ├── SubtitlesSection.tsx   # NEW
    │       └── OutputSection.tsx      # NEW
    └── pages/
        └── Settings.tsx               # MODIFY: compose 5 sections inside SettingsLayout
tests/
├── main/
│   ├── SettingsStore.test.ts          # (lives next to source per project pattern? — see Task 4)
│   └── SecureStorage.test.ts
└── renderer/
    └── Settings.test.tsx              # NEW: smoke test (render + save flow)
```

**Decomposition rationale:**
- `shared/settings.ts` is the single source of truth: schema + defaults + types, imported by main and renderer.
- Each section component (`ApiModelSection`, etc.) owns its own subset of the settings tree and emits whole-section patches up to the page; this keeps each file small and testable.
- `SettingsCard` and `SettingsRow` are reusable layout primitives so future settings additions don't reinvent chrome.
- Storage wrappers (`SettingsStore`, `SecureStorage`) sit in `src/main/infra/` because they're main-process-only and both use Electron-specific APIs.
- Unit tests for the two storage wrappers live next to their source as `*.test.ts` (vitest discovers them via the existing config). The renderer smoke test goes under `tests/renderer/` like the M1 smoke test.

---

## Tasks

### Task 1: Settings schema + defaults (shared)

**Files:**
- Create: `src/shared/settings.ts`

This file is consumed by both main and renderer. It defines the schema once.

- [ ] **Step 1: Create `src/shared/settings.ts`**

```ts
import { z } from 'zod';

export const WhisperModelSchema = z.enum(['tiny', 'base', 'small', 'medium', 'large-v3']);
export type WhisperModel = z.infer<typeof WhisperModelSchema>;

export const WhisperLanguageSchema = z.enum(['auto', 'ko', 'en', 'ja', 'zh']);
export type WhisperLanguage = z.infer<typeof WhisperLanguageSchema>;

export const WhisperDeviceSchema = z.enum(['auto', 'cpu', 'cuda', 'metal']);
export type WhisperDevice = z.infer<typeof WhisperDeviceSchema>;

export const SubtitlePositionSchema = z.enum(['bottom', 'middle']);
export type SubtitlePosition = z.infer<typeof SubtitlePositionSchema>;

export const SettingsSchema = z.object({
  paths: z.object({
    downloads: z.string().min(1),
    workspace: z.string().min(1),
    outputs: z.string().min(1),
  }),
  llm: z.object({
    provider: z.literal('openrouter'),
    model: z.string().min(1),
  }),
  whisper: z.object({
    model: WhisperModelSchema,
    language: WhisperLanguageSchema,
    device: WhisperDeviceSchema,
  }),
  shorts: z.object({
    defaultCount: z.number().int().min(1).max(10),
    minSec: z.number().int().min(5).max(180),
    maxSec: z.number().int().min(5).max(180),
  }),
  subtitles: z.object({
    enabled: z.boolean(),
    fontFamily: z.string().min(1),
    fontSize: z.number().int().min(16).max(160),
    fillColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    outlineColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    position: SubtitlePositionSchema,
  }),
  ui: z.object({
    historyView: z.enum(['list', 'thumbnails']),
    theme: z.literal('light'),
  }),
});

export type Settings = z.infer<typeof SettingsSchema>;

/**
 * Default values used when no persisted settings exist yet, or when filling
 * gaps in a partial persisted blob. The path defaults are placeholders —
 * `SettingsStore` resolves them to real OS paths at first read.
 */
export const DEFAULT_SETTINGS_TEMPLATE: Omit<Settings, 'paths'> & {
  paths: { downloads: ''; workspace: ''; outputs: '' };
} = {
  paths: { downloads: '', workspace: '', outputs: '' },
  llm: {
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4.5',
  },
  whisper: {
    model: 'small',
    language: 'auto',
    device: 'auto',
  },
  shorts: {
    defaultCount: 3,
    minSec: 20,
    maxSec: 60,
  },
  subtitles: {
    enabled: true,
    fontFamily: 'Pretendard',
    fontSize: 64,
    fillColor: '#FFFFFF',
    outlineColor: '#000000',
    position: 'bottom',
  },
  ui: {
    historyView: 'list',
    theme: 'light',
  },
};
```

- [ ] **Step 2: Format**

```bash
yarn prettier --write src/shared/settings.ts
```

- [ ] **Step 3: Verify lint + typecheck**

```bash
yarn lint && yarn typecheck
```

Expected: both exit 0 (the existing `__dirname` warning in `main.ts` is OK).

- [ ] **Step 4: Commit**

```bash
git add src/shared/settings.ts
git commit -m "feat(m2): add Settings schema and defaults in shared/settings.ts"
```

---

### Task 2: Install M2 dependencies

**Files:**
- Modify: `package.json` + `yarn.lock`

- [ ] **Step 1: Install runtime deps**

```bash
yarn add electron-store@^10.0.0 zod@^3.24.0
```

> `electron-store@10` is ESM-only and matches our `"type": "module"` package. `zod@^3.24` is the latest stable — same peer ranges as bob-park config.

- [ ] **Step 2: Verify install**

```bash
ls -d node_modules/electron-store node_modules/zod
```

Expected: both directories exist.

- [ ] **Step 3: Confirm typecheck still passes**

```bash
yarn typecheck
```

Expected: exit 0. (`shared/settings.ts` from Task 1 imports `zod`; this confirms the install resolved it.)

- [ ] **Step 4: Commit**

```bash
git add package.json yarn.lock
git commit -m "chore(m2): add electron-store and zod dependencies"
```

---

### Task 3: IPC contract extension (shared)

**Files:**
- Modify: `src/shared/ipc.ts`

Extend `AppApi` with all M2 methods. Both main (handler signatures) and renderer (hook implementations) will be type-checked against this single contract.

- [ ] **Step 1: Replace `src/shared/ipc.ts` with the extended contract**

Replace the entire file:

```ts
import type { Settings } from './settings';

/**
 * Typed IPC bridge between renderer and main.
 * Channels and methods are added as features land.
 */
export interface AppApi {
  /** App version surfaced from main → renderer at boot. */
  getAppVersion(): Promise<string>;

  /** Settings persistence (electron-store backed). */
  getSettings(): Promise<Settings>;
  /** Patch a subset of settings; main validates against the schema. */
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  /** Reset to defaults (paths re-resolved to OS standard). */
  resetSettings(): Promise<Settings>;

  /** OpenRouter API key (safeStorage backed; never echoed back in plaintext). */
  hasApiKey(): Promise<boolean>;
  setApiKey(key: string): Promise<void>;
  clearApiKey(): Promise<void>;

  /** Native folder picker; returns selected absolute path or null on cancel. */
  pickFolder(opts: { title?: string; defaultPath?: string }): Promise<string | null>;
}

declare global {
  interface Window {
    api: AppApi;
  }
}

export {};
```

- [ ] **Step 2: Format**

```bash
yarn prettier --write src/shared/ipc.ts
```

- [ ] **Step 3: Verify typecheck**

```bash
yarn typecheck
```

Expected: exit 0.

> Note: `yarn lint` may now complain about `preload.ts` because the existing `api` const only implements `getAppVersion`, not the new methods. The next task (preload bridge update — bundled in Task 7) fixes this. Run lint at the end of Task 7, not now.

- [ ] **Step 4: Commit**

```bash
git add src/shared/ipc.ts
git commit -m "feat(m2): extend AppApi with settings, secure storage, and folder picker"
```

---

### Task 4: SettingsStore (electron-store wrapper) — TDD

**Files:**
- Create: `src/main/infra/SettingsStore.ts`
- Create: `src/main/infra/SettingsStore.test.ts`

`SettingsStore` is a thin wrapper that fills path defaults from OS paths at first read, validates persisted data with the zod schema, and merges patches.

- [ ] **Step 1: Write the failing test**

Create `src/main/infra/SettingsStore.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SettingsStore } from './SettingsStore';
import type { Settings } from '@shared/settings';

// In-memory mock for electron-store's get/set/clear surface.
class FakeStore {
  private data: Record<string, unknown> = {};
  get(key: string): unknown {
    return this.data[key];
  }
  set(key: string, value: unknown): void {
    this.data[key] = value;
  }
  clear(): void {
    this.data = {};
  }
  get store(): Record<string, unknown> {
    return { ...this.data };
  }
}

const osPaths = {
  downloads: '/Users/test/Downloads',
  documents: '/Users/test/Documents',
};

describe('SettingsStore', () => {
  let fake: FakeStore;
  let store: SettingsStore;

  beforeEach(() => {
    fake = new FakeStore();
    store = new SettingsStore(fake as never, osPaths);
  });

  it('returns full defaults when nothing is persisted, with paths resolved to OS dirs', () => {
    const s = store.get();
    expect(s.paths.downloads).toContain('Downloads');
    expect(s.paths.workspace).toContain('Documents');
    expect(s.paths.outputs).toContain('Downloads');
    expect(s.llm.provider).toBe('openrouter');
    expect(s.shorts.defaultCount).toBe(3);
  });

  it('merges a patch into persisted state and returns the merged result', () => {
    const merged = store.update({ shorts: { defaultCount: 5, minSec: 30, maxSec: 90 } });
    expect(merged.shorts.defaultCount).toBe(5);
    // Other sections preserved
    expect(merged.llm.provider).toBe('openrouter');
    // Round-trip: a fresh read returns the same merged state
    expect(store.get().shorts.defaultCount).toBe(5);
  });

  it('rejects a patch that violates the schema', () => {
    expect(() =>
      store.update({ shorts: { defaultCount: 99, minSec: 30, maxSec: 90 } } as Partial<Settings>),
    ).toThrow();
  });

  it('reset() clears persisted data and returns regenerated defaults', () => {
    store.update({ shorts: { defaultCount: 5, minSec: 30, maxSec: 90 } });
    const reset = store.reset();
    expect(reset.shorts.defaultCount).toBe(3);
    expect(fake.store).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
yarn test src/main/infra/SettingsStore.test.ts
```

Expected: FAIL with "Cannot find module './SettingsStore'" or similar.

- [ ] **Step 3: Implement SettingsStore**

Create `src/main/infra/SettingsStore.ts`:

```ts
import type Store from 'electron-store';
import { DEFAULT_SETTINGS_TEMPLATE, SettingsSchema, type Settings } from '@shared/settings';

/**
 * Standard OS paths needed to resolve default folders. Injected by the caller
 * (main.ts) so this module stays testable without importing electron.
 */
export interface OsPaths {
  downloads: string;
  documents: string;
}

/**
 * Minimal surface of electron-store we depend on. Lets us mock in tests
 * without pulling in the real package.
 */
type StoreLike = Pick<Store<Settings>, 'get' | 'set' | 'clear'>;

const SETTINGS_KEY = 'settings';

export class SettingsStore {
  constructor(
    private readonly backing: StoreLike,
    private readonly osPaths: OsPaths,
  ) {}

  get(): Settings {
    const persisted = this.backing.get(SETTINGS_KEY) as Partial<Settings> | undefined;
    return this.materialize(persisted ?? {});
  }

  update(patch: Partial<Settings>): Settings {
    const current = this.get();
    const merged = this.deepMerge(current, patch);
    const validated = SettingsSchema.parse(merged); // throws on schema violation
    this.backing.set(SETTINGS_KEY, validated);
    return validated;
  }

  reset(): Settings {
    this.backing.clear();
    return this.get();
  }

  /** Fills defaults (including path resolution) over a possibly-partial persisted blob. */
  private materialize(persisted: Partial<Settings>): Settings {
    const defaults: Settings = {
      ...DEFAULT_SETTINGS_TEMPLATE,
      paths: {
        downloads: this.osPaths.downloads,
        workspace: `${this.osPaths.documents}/SimpleShortsAI/workspace`,
        outputs: `${this.osPaths.downloads}/SimpleShortsAI`,
      },
    };
    const merged = this.deepMerge(defaults, persisted);
    return SettingsSchema.parse(merged);
  }

  private deepMerge<T>(target: T, source: Partial<T>): T {
    const out: Record<string, unknown> = { ...(target as Record<string, unknown>) };
    for (const [k, v] of Object.entries(source as Record<string, unknown>)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && k in out) {
        out[k] = this.deepMerge(out[k], v as Partial<unknown>);
      } else if (v !== undefined) {
        out[k] = v;
      }
    }
    return out as T;
  }
}
```

- [ ] **Step 4: Run test to verify passes**

```bash
yarn test src/main/infra/SettingsStore.test.ts
```

Expected: 4/4 passing.

- [ ] **Step 5: Format + lint**

```bash
yarn prettier --write src/main/infra/SettingsStore.ts src/main/infra/SettingsStore.test.ts
yarn lint
```

Expected: lint exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/main/infra/SettingsStore.ts src/main/infra/SettingsStore.test.ts
git commit -m "feat(m2): add SettingsStore with schema validation and defaults"
```

---

### Task 5: SecureStorage (safeStorage wrapper) — TDD

**Files:**
- Create: `src/main/infra/SecureStorage.ts`
- Create: `src/main/infra/SecureStorage.test.ts`

Encrypts the API key with `safeStorage` and writes the ciphertext to a file in `userData`.

- [ ] **Step 1: Write the failing test**

Create `src/main/infra/SecureStorage.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SecureStorage } from './SecureStorage';

class FakeFs {
  private files = new Map<string, Buffer>();
  async writeFile(path: string, data: Buffer): Promise<void> {
    this.files.set(path, Buffer.from(data));
  }
  async readFile(path: string): Promise<Buffer> {
    const data = this.files.get(path);
    if (!data) {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return data;
  }
  async unlink(path: string): Promise<void> {
    if (!this.files.delete(path)) {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
  }
  has(path: string): boolean {
    return this.files.has(path);
  }
}

// Trivial reversible "encryption" so we can assert round-trip behavior.
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from('enc:' + s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
};

describe('SecureStorage', () => {
  let fs: FakeFs;
  let storage: SecureStorage;
  const path = '/tmp/test-secrets.bin';

  beforeEach(() => {
    fs = new FakeFs();
    storage = new SecureStorage(path, fakeSafeStorage, fs as never);
  });

  it('hasKey() returns false when nothing is stored', async () => {
    expect(await storage.hasKey()).toBe(false);
  });

  it('setKey() encrypts and persists; getKey() decrypts and returns the original', async () => {
    await storage.setKey('sk-or-v1-abcdef');
    expect(await storage.hasKey()).toBe(true);
    expect(await storage.getKey()).toBe('sk-or-v1-abcdef');
  });

  it('clearKey() removes the file; subsequent hasKey() returns false', async () => {
    await storage.setKey('sk-or-v1-abcdef');
    await storage.clearKey();
    expect(await storage.hasKey()).toBe(false);
    expect(await storage.getKey()).toBeNull();
  });

  it('clearKey() is idempotent — clearing when already absent is not an error', async () => {
    await expect(storage.clearKey()).resolves.toBeUndefined();
  });

  it('throws when safeStorage encryption is unavailable', async () => {
    const unavailable = {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
    };
    const broken = new SecureStorage(path, unavailable, fs as never);
    await expect(broken.setKey('x')).rejects.toThrow(/encryption not available/i);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
yarn test src/main/infra/SecureStorage.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement SecureStorage**

Create `src/main/infra/SecureStorage.ts`:

```ts
import type { promises as FsPromises } from 'node:fs';

/** Minimal surface of Electron's safeStorage we depend on. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** Minimal fs surface for testability. */
type FsLike = Pick<typeof FsPromises, 'writeFile' | 'readFile' | 'unlink'>;

export class SecureStorage {
  constructor(
    private readonly filePath: string,
    private readonly safeStorage: SafeStorageLike,
    private readonly fs: FsLike,
  ) {}

  async hasKey(): Promise<boolean> {
    try {
      await this.fs.readFile(this.filePath);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw e;
    }
  }

  async setKey(plaintext: string): Promise<void> {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('safeStorage encryption not available on this platform');
    }
    const encrypted = this.safeStorage.encryptString(plaintext);
    await this.fs.writeFile(this.filePath, encrypted);
  }

  async getKey(): Promise<string | null> {
    try {
      const encrypted = await this.fs.readFile(this.filePath);
      return this.safeStorage.decryptString(encrypted);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async clearKey(): Promise<void> {
    try {
      await this.fs.unlink(this.filePath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}
```

- [ ] **Step 4: Run test to verify passes**

```bash
yarn test src/main/infra/SecureStorage.test.ts
```

Expected: 5/5 passing.

- [ ] **Step 5: Format + lint**

```bash
yarn prettier --write src/main/infra/SecureStorage.ts src/main/infra/SecureStorage.test.ts
yarn lint
```

Expected: lint exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/main/infra/SecureStorage.ts src/main/infra/SecureStorage.test.ts
git commit -m "feat(m2): add SecureStorage wrapping Electron safeStorage"
```

---

### Task 6: Wire IPC handlers in main.ts

**Files:**
- Modify: `src/main/main.ts`

Instantiate the two stores at app startup, register the new IPC handlers, and add the folder picker dialog.

- [ ] **Step 1: Modify `src/main/main.ts`**

Apply the following changes:

a. **Add imports** at the top, after the existing electron import:

```ts
import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } from 'electron';
import Store from 'electron-store';
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettingsStore } from './infra/SettingsStore';
import { SecureStorage } from './infra/SecureStorage';
import type { Settings } from '@shared/settings';
```

(Remove the standalone `import { app, BrowserWindow, ipcMain, session, shell } from 'electron';` line and replace with the augmented one above.)

b. **After `const isDev = !app.isPackaged;`**, declare module-level holders for the stores (initialized in `whenReady`):

```ts
let settingsStore: SettingsStore;
let secureStorage: SecureStorage;
```

c. **Replace the `whenReady` block** with:

```ts
void app.whenReady().then(() => {
  setupContentSecurityPolicy();

  // Storage init
  const electronStore = new Store<Settings>();
  settingsStore = new SettingsStore(electronStore, {
    downloads: app.getPath('downloads'),
    documents: app.getPath('documents'),
  });
  secureStorage = new SecureStorage(
    join(app.getPath('userData'), 'secrets.bin'),
    safeStorage,
    fsPromises,
  );

  // IPC handlers
  ipcMain.handle('app:getVersion', () => app.getVersion());

  ipcMain.handle('settings:get', () => settingsStore.get());
  ipcMain.handle('settings:update', (_e, patch: Partial<Settings>) => settingsStore.update(patch));
  ipcMain.handle('settings:reset', () => settingsStore.reset());

  ipcMain.handle('secure:hasKey', () => secureStorage.hasKey());
  ipcMain.handle('secure:setKey', (_e, key: string) => secureStorage.setKey(key));
  ipcMain.handle('secure:clearKey', () => secureStorage.clearKey());

  ipcMain.handle(
    'dialog:pickFolder',
    async (_e, opts: { title?: string; defaultPath?: string }) => {
      const result = await dialog.showOpenDialog({
        title: opts.title,
        defaultPath: opts.defaultPath,
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    },
  );

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});
```

- [ ] **Step 2: Format**

```bash
yarn prettier --write src/main/main.ts
```

- [ ] **Step 3: Verify lint + typecheck**

```bash
yarn lint && yarn typecheck
```

Expected: lint exits 0 (besides existing `__dirname` warning); typecheck exits 0.

> If typecheck reports `electron-store` has no type declarations or default-export issues with ESM, ensure you imported as `import Store from 'electron-store'` (default export). If still failing, the `electron-store` package may need `import { default as Store } from 'electron-store'` in some yarn linker arrangements; report the exact error.

- [ ] **Step 4: Commit**

```bash
git add src/main/main.ts
git commit -m "feat(m2): wire SettingsStore, SecureStorage, and folder picker IPC in main"
```

---

### Task 7: Update preload bridge

**Files:**
- Modify: `src/main/preload.ts`

Expose the new methods on `window.api`.

- [ ] **Step 1: Replace `src/main/preload.ts`**

Replace the entire file:

```ts
import type { AppApi } from '@shared/ipc';
import type { Settings } from '@shared/settings';
import { contextBridge, ipcRenderer } from 'electron';

const api: AppApi = {
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:update', patch),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),

  hasApiKey: () => ipcRenderer.invoke('secure:hasKey'),
  setApiKey: (key: string) => ipcRenderer.invoke('secure:setKey', key),
  clearApiKey: () => ipcRenderer.invoke('secure:clearKey'),

  pickFolder: (opts) => ipcRenderer.invoke('dialog:pickFolder', opts),
};

contextBridge.exposeInMainWorld('api', api);
```

- [ ] **Step 2: Format + verify**

```bash
yarn prettier --write src/main/preload.ts
yarn lint && yarn typecheck && yarn test
```

Expected: all exit 0; existing 3 smoke tests still pass.

- [ ] **Step 3: Commit**

```bash
git add src/main/preload.ts
git commit -m "feat(m2): expose settings, secure storage, and folder picker on window.api"
```

---

### Task 8: useSettings hook

**Files:**
- Create: `src/renderer/hooks/useSettings.ts`

A thin wrapper that loads settings on mount and provides an updater that re-syncs from main on success.

- [ ] **Step 1: Create `src/renderer/hooks/useSettings.ts`**

```ts
import { useCallback, useEffect, useState } from 'react';
import type { Settings } from '@shared/settings';

export type UseSettings = {
  settings: Settings | null;
  loading: boolean;
  error: Error | null;
  update: (patch: Partial<Settings>) => Promise<void>;
  reset: () => Promise<void>;
};

export function useSettings(): UseSettings {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.api
      .getSettings()
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(async (patch: Partial<Settings>) => {
    const next = await window.api.updateSettings(patch);
    setSettings(next);
  }, []);

  const reset = useCallback(async () => {
    const next = await window.api.resetSettings();
    setSettings(next);
  }, []);

  return { settings, loading, error, update, reset };
}
```

- [ ] **Step 2: Format + verify**

```bash
yarn prettier --write src/renderer/hooks/useSettings.ts
yarn lint && yarn typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/hooks/useSettings.ts
git commit -m "feat(m2): add useSettings hook for renderer"
```

---

### Task 9: useApiKey hook

**Files:**
- Create: `src/renderer/hooks/useApiKey.ts`

The renderer never sees the plaintext key after it's set — only `hasApiKey` boolean state, plus setters.

- [ ] **Step 1: Create `src/renderer/hooks/useApiKey.ts`**

```ts
import { useCallback, useEffect, useState } from 'react';

export type UseApiKey = {
  hasKey: boolean | null;
  setKey: (plaintext: string) => Promise<void>;
  clearKey: () => Promise<void>;
};

export function useApiKey(): UseApiKey {
  const [hasKey, setHasKey] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.api.hasApiKey().then((value) => {
      if (!cancelled) setHasKey(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setKey = useCallback(async (plaintext: string) => {
    await window.api.setApiKey(plaintext);
    setHasKey(true);
  }, []);

  const clearKey = useCallback(async () => {
    await window.api.clearApiKey();
    setHasKey(false);
  }, []);

  return { hasKey, setKey, clearKey };
}
```

- [ ] **Step 2: Format + verify**

```bash
yarn prettier --write src/renderer/hooks/useApiKey.ts
yarn lint && yarn typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/hooks/useApiKey.ts
git commit -m "feat(m2): add useApiKey hook for renderer"
```

---

### Task 10: SettingsCard + SettingsRow shared components

**Files:**
- Create: `src/renderer/components/settings/SettingsCard.tsx`
- Create: `src/renderer/components/settings/SettingsRow.tsx`

The white-card chrome + label-and-control row used by every section.

- [ ] **Step 1: Create `SettingsCard.tsx`**

```tsx
import type { ReactNode } from 'react';

export function SettingsCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-hairline bg-canvas p-xxl shadow-1">
      <header className="mb-xl">
        <h2 className="text-card-title font-semibold text-ink">{title}</h2>
        {description ? <p className="mt-xxs text-body-sm text-slate">{description}</p> : null}
      </header>
      <div className="flex flex-col gap-lg">{children}</div>
    </section>
  );
}
```

- [ ] **Step 2: Create `SettingsRow.tsx`**

```tsx
import type { ReactNode } from 'react';

export function SettingsRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-xs">
      <span className="text-body-sm-medium text-ink">{label}</span>
      {hint ? <span className="text-caption text-stone">{hint}</span> : null}
      <div>{children}</div>
    </label>
  );
}
```

> The `text-body-sm-medium` Tailwind utility maps to `--text-body-sm` size + medium weight; if you need explicit weight, add `font-medium` (Tailwind v4 generates `font-medium` natively). Adjust if the M1 type-scale tokens didn't include the medium variant — just use `text-body-sm font-medium` instead.

- [ ] **Step 3: Format + verify**

```bash
yarn prettier --write src/renderer/components/settings/
yarn lint && yarn typecheck
```

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/settings/SettingsCard.tsx src/renderer/components/settings/SettingsRow.tsx
git commit -m "feat(m2): add SettingsCard and SettingsRow layout primitives"
```

---

### Task 11: PathInput component

**Files:**
- Create: `src/renderer/components/settings/PathInput.tsx`

Text input + "찾아보기" button. Clicking the button opens the OS folder picker via IPC.

- [ ] **Step 1: Create `PathInput.tsx`**

```tsx
import { useState } from 'react';

export function PathInput({
  value,
  onChange,
  dialogTitle,
}: {
  value: string;
  onChange: (next: string) => void;
  dialogTitle: string;
}) {
  const [busy, setBusy] = useState(false);

  async function browse() {
    setBusy(true);
    try {
      const picked = await window.api.pickFolder({ title: dialogTitle, defaultPath: value });
      if (picked) onChange(picked);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex gap-sm">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="h-10 flex-1 rounded-md border border-hairline bg-canvas px-md text-body-sm text-ink focus:border-brand-blue-deep focus:outline-none"
      />
      <button
        type="button"
        onClick={browse}
        disabled={busy}
        className="h-10 rounded-full border border-ink bg-transparent px-xl text-button-md font-semibold text-ink disabled:opacity-50"
      >
        찾아보기
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Format + verify**

```bash
yarn prettier --write src/renderer/components/settings/PathInput.tsx
yarn lint && yarn typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/settings/PathInput.tsx
git commit -m "feat(m2): add PathInput with folder dialog trigger"
```

---

### Task 12: PasswordInput component

**Files:**
- Create: `src/renderer/components/settings/PasswordInput.tsx`

Password-style input with a show/hide toggle. Used for the API key entry.

- [ ] **Step 1: Create `PasswordInput.tsx`**

```tsx
import { useState } from 'react';

export function PasswordInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex gap-sm">
      <input
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className="h-10 flex-1 rounded-md border border-hairline bg-canvas px-md text-body-sm text-ink focus:border-brand-blue-deep focus:outline-none"
      />
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        className="h-10 rounded-full border border-ink bg-transparent px-xl text-button-md font-semibold text-ink"
      >
        {shown ? '숨기기' : '표시'}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Format + verify**

```bash
yarn prettier --write src/renderer/components/settings/PasswordInput.tsx
yarn lint && yarn typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/settings/PasswordInput.tsx
git commit -m "feat(m2): add PasswordInput with show/hide toggle"
```

---

### Task 13: ApiModelSection

**Files:**
- Create: `src/renderer/components/settings/ApiModelSection.tsx`

Combines API key (via useApiKey) + LLM model text field (via useSettings).

- [ ] **Step 1: Create `ApiModelSection.tsx`**

```tsx
import { useState } from 'react';
import type { Settings } from '@shared/settings';
import { useApiKey } from '../../hooks/useApiKey';
import { PasswordInput } from './PasswordInput';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';

export function ApiModelSection({
  llm,
  onLlmChange,
}: {
  llm: Settings['llm'];
  onLlmChange: (next: Settings['llm']) => void;
}) {
  const { hasKey, setKey, clearKey } = useApiKey();
  const [draft, setDraft] = useState('');

  async function saveKey() {
    if (!draft) return;
    await setKey(draft);
    setDraft('');
  }

  return (
    <SettingsCard
      title="API & 모델"
      description="OpenRouter 키와 사용할 LLM 모델을 설정하세요."
    >
      <SettingsRow
        label="OpenRouter API 키"
        hint={
          hasKey === null
            ? '확인 중...'
            : hasKey
              ? '키가 저장되어 있습니다 (덮어쓰려면 새 키를 입력하세요).'
              : '아직 키가 저장되지 않았습니다.'
        }
      >
        <div className="flex flex-col gap-sm">
          <PasswordInput value={draft} onChange={setDraft} placeholder="sk-or-v1-..." />
          <div className="flex gap-sm">
            <button
              type="button"
              onClick={saveKey}
              disabled={!draft}
              className="h-10 rounded-full bg-primary px-xl text-button-md font-semibold text-on-primary disabled:opacity-50"
            >
              저장
            </button>
            {hasKey ? (
              <button
                type="button"
                onClick={() => clearKey()}
                className="h-10 rounded-full border border-ink bg-transparent px-xl text-button-md font-semibold text-ink"
              >
                삭제
              </button>
            ) : null}
          </div>
        </div>
      </SettingsRow>

      <SettingsRow
        label="LLM 모델"
        hint="예: anthropic/claude-sonnet-4.5, openai/gpt-4.1, google/gemini-2.5-pro"
      >
        <input
          type="text"
          value={llm.model}
          onChange={(e) => onLlmChange({ ...llm, model: e.target.value })}
          spellCheck={false}
          className="h-10 w-full rounded-md border border-hairline bg-canvas px-md text-body-sm text-ink focus:border-brand-blue-deep focus:outline-none"
        />
      </SettingsRow>
    </SettingsCard>
  );
}
```

- [ ] **Step 2: Format + verify**

```bash
yarn prettier --write src/renderer/components/settings/ApiModelSection.tsx
yarn lint && yarn typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/settings/ApiModelSection.tsx
git commit -m "feat(m2): add ApiModelSection (API key + LLM model)"
```

---

### Task 14: PathsSection

**Files:**
- Create: `src/renderer/components/settings/PathsSection.tsx`

Three folder pickers.

- [ ] **Step 1: Create `PathsSection.tsx`**

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
    <SettingsCard
      title="경로"
      description="다운로드한 원본·작업 파일·완성된 숏츠가 저장될 위치입니다."
    >
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
    </SettingsCard>
  );
}
```

- [ ] **Step 2: Format + verify**

```bash
yarn prettier --write src/renderer/components/settings/PathsSection.tsx
yarn lint && yarn typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/settings/PathsSection.tsx
git commit -m "feat(m2): add PathsSection (downloads/workspace/outputs)"
```

---

### Task 15: WhisperSection

**Files:**
- Create: `src/renderer/components/settings/WhisperSection.tsx`

Three dropdowns: model, language, device.

- [ ] **Step 1: Create `WhisperSection.tsx`**

```tsx
import type { Settings, WhisperDevice, WhisperLanguage, WhisperModel } from '@shared/settings';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';

const SELECT_CLASS =
  'h-10 w-full rounded-md border border-hairline bg-canvas px-md text-body-sm text-ink focus:border-brand-blue-deep focus:outline-none';

const MODELS: { value: WhisperModel; label: string }[] = [
  { value: 'tiny', label: 'tiny (가장 빠름, 정확도 낮음)' },
  { value: 'base', label: 'base' },
  { value: 'small', label: 'small (권장)' },
  { value: 'medium', label: 'medium' },
  { value: 'large-v3', label: 'large-v3 (가장 정확, 느림)' },
];

const LANGUAGES: { value: WhisperLanguage; label: string }[] = [
  { value: 'auto', label: '자동 감지' },
  { value: 'ko', label: '한국어' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'zh', label: '中文' },
];

const DEVICES: { value: WhisperDevice; label: string }[] = [
  { value: 'auto', label: '자동' },
  { value: 'cpu', label: 'CPU' },
  { value: 'cuda', label: 'CUDA (NVIDIA GPU)' },
  { value: 'metal', label: 'Metal (Apple Silicon)' },
];

export function WhisperSection({
  whisper,
  onChange,
}: {
  whisper: Settings['whisper'];
  onChange: (next: Settings['whisper']) => void;
}) {
  return (
    <SettingsCard title="Whisper 모델" description="로컬 음성 인식(STT) 설정입니다.">
      <SettingsRow label="모델 크기" hint="모델이 클수록 정확도는 올라가고 속도는 느려집니다.">
        <select
          className={SELECT_CLASS}
          value={whisper.model}
          onChange={(e) => onChange({ ...whisper, model: e.target.value as WhisperModel })}
        >
          {MODELS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </SettingsRow>
      <SettingsRow label="언어">
        <select
          className={SELECT_CLASS}
          value={whisper.language}
          onChange={(e) => onChange({ ...whisper, language: e.target.value as WhisperLanguage })}
        >
          {LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </SettingsRow>
      <SettingsRow label="실행 장치" hint="`자동`은 사용 가능한 가속을 자동 선택합니다.">
        <select
          className={SELECT_CLASS}
          value={whisper.device}
          onChange={(e) => onChange({ ...whisper, device: e.target.value as WhisperDevice })}
        >
          {DEVICES.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
      </SettingsRow>
    </SettingsCard>
  );
}
```

- [ ] **Step 2: Format + verify**

```bash
yarn prettier --write src/renderer/components/settings/WhisperSection.tsx
yarn lint && yarn typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/settings/WhisperSection.tsx
git commit -m "feat(m2): add WhisperSection (model/language/device)"
```

---

### Task 16: SubtitlesSection

**Files:**
- Create: `src/renderer/components/settings/SubtitlesSection.tsx`

Toggle, font family, font size, fill/outline colors, position.

- [ ] **Step 1: Create `SubtitlesSection.tsx`**

```tsx
import type { Settings, SubtitlePosition } from '@shared/settings';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';

const INPUT_CLASS =
  'h-10 w-full rounded-md border border-hairline bg-canvas px-md text-body-sm text-ink focus:border-brand-blue-deep focus:outline-none';

const POSITIONS: { value: SubtitlePosition; label: string }[] = [
  { value: 'bottom', label: '하단' },
  { value: 'middle', label: '중앙' },
];

export function SubtitlesSection({
  subtitles,
  onChange,
}: {
  subtitles: Settings['subtitles'];
  onChange: (next: Settings['subtitles']) => void;
}) {
  return (
    <SettingsCard title="자막 스타일" description="숏츠에 구워넣을 자막 모양을 설정하세요.">
      <SettingsRow label="자막 사용">
        <label className="flex items-center gap-xs">
          <input
            type="checkbox"
            checked={subtitles.enabled}
            onChange={(e) => onChange({ ...subtitles, enabled: e.target.checked })}
          />
          <span className="text-body-sm text-ink">사용함</span>
        </label>
      </SettingsRow>
      <SettingsRow label="폰트 패밀리" hint="시스템에 설치된 폰트 이름을 입력하세요.">
        <input
          type="text"
          className={INPUT_CLASS}
          value={subtitles.fontFamily}
          onChange={(e) => onChange({ ...subtitles, fontFamily: e.target.value })}
        />
      </SettingsRow>
      <SettingsRow label="폰트 크기 (px, 1080×1920 기준)">
        <input
          type="number"
          className={INPUT_CLASS}
          min={16}
          max={160}
          value={subtitles.fontSize}
          onChange={(e) => onChange({ ...subtitles, fontSize: Number(e.target.value) })}
        />
      </SettingsRow>
      <SettingsRow label="채움 색상">
        <input
          type="color"
          className="h-10 w-20 rounded-md border border-hairline bg-canvas"
          value={subtitles.fillColor}
          onChange={(e) => onChange({ ...subtitles, fillColor: e.target.value.toUpperCase() })}
        />
      </SettingsRow>
      <SettingsRow label="외곽선 색상">
        <input
          type="color"
          className="h-10 w-20 rounded-md border border-hairline bg-canvas"
          value={subtitles.outlineColor}
          onChange={(e) =>
            onChange({ ...subtitles, outlineColor: e.target.value.toUpperCase() })
          }
        />
      </SettingsRow>
      <SettingsRow label="위치">
        <select
          className={INPUT_CLASS}
          value={subtitles.position}
          onChange={(e) =>
            onChange({ ...subtitles, position: e.target.value as SubtitlePosition })
          }
        >
          {POSITIONS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </SettingsRow>
    </SettingsCard>
  );
}
```

- [ ] **Step 2: Format + verify**

```bash
yarn prettier --write src/renderer/components/settings/SubtitlesSection.tsx
yarn lint && yarn typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/settings/SubtitlesSection.tsx
git commit -m "feat(m2): add SubtitlesSection (style/colors/position)"
```

---

### Task 17: OutputSection

**Files:**
- Create: `src/renderer/components/settings/OutputSection.tsx`

Default count + min/max length.

- [ ] **Step 1: Create `OutputSection.tsx`**

```tsx
import type { Settings } from '@shared/settings';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';

const NUMBER_INPUT_CLASS =
  'h-10 w-32 rounded-md border border-hairline bg-canvas px-md text-body-sm text-ink focus:border-brand-blue-deep focus:outline-none';

export function OutputSection({
  shorts,
  onChange,
}: {
  shorts: Settings['shorts'];
  onChange: (next: Settings['shorts']) => void;
}) {
  return (
    <SettingsCard
      title="출력 옵션"
      description="새 작업을 시작할 때 기본으로 사용할 숏츠 개수와 길이 범위입니다."
    >
      <SettingsRow label="기본 숏츠 개수" hint="1 ~ 10 사이">
        <input
          type="number"
          className={NUMBER_INPUT_CLASS}
          min={1}
          max={10}
          value={shorts.defaultCount}
          onChange={(e) => onChange({ ...shorts, defaultCount: Number(e.target.value) })}
        />
      </SettingsRow>
      <SettingsRow label="최소 길이 (초)">
        <input
          type="number"
          className={NUMBER_INPUT_CLASS}
          min={5}
          max={180}
          value={shorts.minSec}
          onChange={(e) => onChange({ ...shorts, minSec: Number(e.target.value) })}
        />
      </SettingsRow>
      <SettingsRow label="최대 길이 (초)">
        <input
          type="number"
          className={NUMBER_INPUT_CLASS}
          min={5}
          max={180}
          value={shorts.maxSec}
          onChange={(e) => onChange({ ...shorts, maxSec: Number(e.target.value) })}
        />
      </SettingsRow>
    </SettingsCard>
  );
}
```

- [ ] **Step 2: Format + verify**

```bash
yarn prettier --write src/renderer/components/settings/OutputSection.tsx
yarn lint && yarn typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/settings/OutputSection.tsx
git commit -m "feat(m2): add OutputSection (count/length range)"
```

---

### Task 18: Compose Settings.tsx page

**Files:**
- Modify: `src/renderer/pages/Settings.tsx`

Replace the placeholder with the real composition. Each section emits whole-section patches; the page calls `update` once per change.

- [ ] **Step 1: Replace `src/renderer/pages/Settings.tsx`**

```tsx
import { ApiModelSection } from '../components/settings/ApiModelSection';
import { OutputSection } from '../components/settings/OutputSection';
import { PathsSection } from '../components/settings/PathsSection';
import { SubtitlesSection } from '../components/settings/SubtitlesSection';
import { WhisperSection } from '../components/settings/WhisperSection';
import { useSettings } from '../hooks/useSettings';

export function SettingsPage() {
  const { settings, loading, error, update } = useSettings();

  if (loading) {
    return (
      <section className="p-section">
        <p className="text-body-md text-slate">설정 불러오는 중...</p>
      </section>
    );
  }

  if (error || !settings) {
    return (
      <section className="p-section">
        <p className="text-body-md text-brand-coral">
          설정을 불러올 수 없습니다: {error?.message ?? 'unknown error'}
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-xl p-section">
      <header>
        <h1 className="text-heading-md font-semibold text-ink">설정</h1>
        <p className="mt-md text-body-md text-slate">
          API 키, 경로, 모델, 자막 등을 한 번 설정해 두면 새 작업마다 기본값으로 쓰입니다.
        </p>
      </header>

      <ApiModelSection
        llm={settings.llm}
        onLlmChange={(llm) => void update({ llm })}
      />
      <PathsSection
        paths={settings.paths}
        onChange={(paths) => void update({ paths })}
      />
      <WhisperSection
        whisper={settings.whisper}
        onChange={(whisper) => void update({ whisper })}
      />
      <SubtitlesSection
        subtitles={settings.subtitles}
        onChange={(subtitles) => void update({ subtitles })}
      />
      <OutputSection
        shorts={settings.shorts}
        onChange={(shorts) => void update({ shorts })}
      />
    </section>
  );
}
```

- [ ] **Step 2: Format + verify**

```bash
yarn prettier --write src/renderer/pages/Settings.tsx
yarn lint && yarn typecheck && yarn test
```

Expected: lint exits 0, typecheck exits 0, existing 3 tests still pass.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/pages/Settings.tsx
git commit -m "feat(m2): replace Settings placeholder with 5-section page"
```

---

### Task 19: Smoke test for Settings page

**Files:**
- Create: `tests/renderer/Settings.test.tsx`

Render the page with a mocked `window.api`, verify all 5 cards render, exercise one save flow.

- [ ] **Step 1: Write the test**

Create `tests/renderer/Settings.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsPage } from '@renderer/pages/Settings';
import type { Settings } from '@shared/settings';

const baseSettings: Settings = {
  paths: {
    downloads: '/Users/test/Downloads',
    workspace: '/Users/test/Documents/SimpleShortsAI/workspace',
    outputs: '/Users/test/Downloads/SimpleShortsAI',
  },
  llm: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' },
  whisper: { model: 'small', language: 'auto', device: 'auto' },
  shorts: { defaultCount: 3, minSec: 20, maxSec: 60 },
  subtitles: {
    enabled: true,
    fontFamily: 'Pretendard',
    fontSize: 64,
    fillColor: '#FFFFFF',
    outlineColor: '#000000',
    position: 'bottom',
  },
  ui: { historyView: 'list', theme: 'light' },
};

function installApiMock(overrides?: Partial<Window['api']>) {
  const calls = {
    updateSettings: vi.fn(async (patch: Partial<Settings>) => ({ ...baseSettings, ...patch })),
    setApiKey: vi.fn(async () => undefined),
    clearApiKey: vi.fn(async () => undefined),
  };
  const api: Window['api'] = {
    getAppVersion: vi.fn(async () => '0.0.1'),
    getSettings: vi.fn(async () => baseSettings),
    updateSettings: calls.updateSettings,
    resetSettings: vi.fn(async () => baseSettings),
    hasApiKey: vi.fn(async () => false),
    setApiKey: calls.setApiKey,
    clearApiKey: calls.clearApiKey,
    pickFolder: vi.fn(async () => null),
    ...overrides,
  };
  Object.defineProperty(window, 'api', { value: api, writable: true, configurable: true });
  return calls;
}

describe('SettingsPage', () => {
  beforeEach(() => {
    installApiMock();
  });

  it('renders all 5 section cards once settings load', async () => {
    render(<SettingsPage />);
    await waitFor(() => screen.getByRole('heading', { name: 'API & 모델' }));
    expect(screen.getByRole('heading', { name: 'API & 모델' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '경로' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Whisper 모델' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '자막 스타일' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '출력 옵션' })).toBeInTheDocument();
  });

  it('saves an updated LLM model via window.api.updateSettings', async () => {
    const calls = installApiMock();
    const user = userEvent.setup();
    render(<SettingsPage />);
    await waitFor(() => screen.getByDisplayValue('anthropic/claude-sonnet-4.5'));
    const input = screen.getByDisplayValue('anthropic/claude-sonnet-4.5');
    await user.clear(input);
    await user.type(input, 'openai/gpt-4.1');
    await waitFor(() =>
      expect(calls.updateSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({ llm: expect.objectContaining({ model: 'openai/gpt-4.1' }) }),
      ),
    );
  });

  it('saves an API key when the user enters one and clicks save', async () => {
    const calls = installApiMock();
    const user = userEvent.setup();
    render(<SettingsPage />);
    await waitFor(() => screen.getByPlaceholderText('sk-or-v1-...'));
    await user.type(screen.getByPlaceholderText('sk-or-v1-...'), 'sk-or-v1-test');
    await user.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(calls.setApiKey).toHaveBeenCalledWith('sk-or-v1-test'));
  });
});
```

- [ ] **Step 2: Run the test**

```bash
yarn test tests/renderer/Settings.test.tsx
```

Expected: 3/3 passing. If any test fails, fix the implementation (don't relax the test). The most likely failure mode is mismatched heading text — verify against Tasks 13–17 if so.

- [ ] **Step 3: Run the full test suite**

```bash
yarn test
```

Expected: all tests pass (3 from M1's `App.test.tsx` + 3 new from `Settings.test.tsx` = 6 total).

- [ ] **Step 4: Format + commit**

```bash
yarn prettier --write tests/renderer/Settings.test.tsx
git add tests/renderer/Settings.test.tsx
git commit -m "test(m2): smoke test for SettingsPage render and save flow"
```

---

### Task 20: Final verification + README + tag

**Files:**
- Modify: `README.md`

Run the full DoD gauntlet, then mark M2 complete and tag.

- [ ] **Step 1: Run all checks**

```bash
yarn typecheck && yarn lint && yarn test && yarn build
```

Expected: all four exit 0. The 6-test suite passes. `out/` rebuilds cleanly.

- [ ] **Step 2: Manual verification**

```bash
yarn dev
```

In the running app:
- Open Settings via the sidebar
- All 5 cards visible (API & 모델, 경로, Whisper 모델, 자막 스타일, 출력 옵션)
- Default paths populated (Downloads, Documents/.../workspace, etc.)
- Click "찾아보기" on a path row → native folder dialog opens
- Type into the API key field, click 저장 → "키가 저장되어 있습니다" hint replaces the placeholder
- Change a Whisper dropdown → reload the page (`yarn dev` runs HMR — manually refresh the renderer or restart) → new value persists

If anything doesn't work, fix and re-run before proceeding.

- [ ] **Step 3: Update README status**

Edit `README.md`'s `## Status` section to:

```markdown
## Status

- ✅ M1: Project Skeleton — Electron + React + TypeScript scaffold, MiniMax tokens, sidebar + 4 placeholder pages, smoke test.
- ✅ M2: Settings page — 5 sections (API & 모델, 경로, Whisper 모델, 자막 스타일, 출력 옵션), electron-store persistence, safeStorage-encrypted API key, native folder dialogs.
- ⏳ M3: YouTube preview + download (next)
```

- [ ] **Step 4: Format + commit README**

```bash
yarn prettier --write README.md
git add README.md
git commit -m "docs(m2): mark milestone 2 complete in README"
```

- [ ] **Step 5: Tag and push**

```bash
git tag -a m2-complete -m "M2: Settings page complete

- 5 settings sections (API & 모델, 경로, Whisper 모델, 자막 스타일, 출력 옵션)
- electron-store JSON persistence with zod schema validation
- safeStorage-encrypted OpenRouter API key (replaces planned keytar — no native module needed)
- Native folder picker via dialog.showOpenDialog
- 6/6 tests passing, lint + typecheck + build green
"
git push origin master
git push origin m2-complete
```

---

## Definition of Done (M2)

All of these must be true before declaring M2 finished:

1. `yarn typecheck`, `yarn lint`, `yarn test`, `yarn build` all exit 0.
2. `yarn test` reports 6 passing (3 M1 smoke + 3 M2 smoke).
3. The Settings page renders all 5 cards with current values populated from `electron-store`.
4. Folder picker buttons open the native OS dialog.
5. Saving the API key encrypts via `safeStorage` and persists across app restarts.
6. Editing any other field calls `updateSettings`, persists, and survives a renderer reload.
7. Master pushed to origin with tag `m2-complete`.

## What's NOT in M2 (intentionally deferred)

- Validation feedback UI (e.g., showing "min must be ≤ max" on the shorts length range) — happens at save time via zod, errors propagate to the user only as a toast in M3+.
- Color picker UI sophistication beyond `<input type="color">`.
- LLM model autocomplete from OpenRouter `/models` API — current text field suffices for v1.
- Theme switching (dark mode) — explicitly out of v1 scope.
- "Reset to defaults" button — schema and store both support it (`resetSettings` IPC method exists), but the UI surface comes when needed.
- Migration logic for an evolving Settings schema across versions — first version, no migration needed yet.

## Notes for the implementing agent

- **Do not bundle multiple sections per task.** Each section component is a 30–80 line focused file; trying to batch them obscures progress and makes review harder.
- **Do not invent Tailwind utility names.** All utilities derive from `@theme` tokens in `src/renderer/styles/global.css` (M1). If you need `text-body-sm-medium`, verify it exists; if not, decompose into `text-body-sm font-medium`.
- **Do not change the IPC surface mid-stream.** If a method needs different shape than declared in `src/shared/ipc.ts` (Task 3), update Task 3's contract first, then propagate consistently to preload (Task 7) and the consumer.
- **Do not store the plaintext API key anywhere outside `safeStorage`.** Renderer hooks expose only `hasKey: boolean` and the setter — never re-read the plaintext into renderer memory.
- **Do not run `electron-rebuild`** — `safeStorage` is built into Electron and `electron-store@10` is pure JS, so no native module compilation is needed.
- The `__dirname` lint warning in `src/main/main.ts` (carried over from M1) is acceptable. Don't suppress it without asking.
