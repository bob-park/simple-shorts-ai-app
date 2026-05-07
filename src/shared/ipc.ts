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
