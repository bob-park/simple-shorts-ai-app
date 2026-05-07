import { DEFAULT_SETTINGS_TEMPLATE, type Settings, SettingsSchema } from '@shared/settings';
import type Store from 'electron-store';

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
