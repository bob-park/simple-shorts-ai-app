import type { Settings } from '@shared/settings';
import { beforeEach, describe, expect, it } from 'vitest';

import { SettingsStore } from './SettingsStore';

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
    expect(() => store.update({ shorts: { defaultCount: 99, minSec: 30, maxSec: 90 } } as Partial<Settings>)).toThrow();
  });

  it('reset() clears persisted data and returns regenerated defaults', () => {
    store.update({ shorts: { defaultCount: 5, minSec: 30, maxSec: 90 } });
    const reset = store.reset();
    expect(reset.shorts.defaultCount).toBe(3);
    expect(fake.store).toEqual({});
  });
});
