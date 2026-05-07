/**
 * Typed IPC bridge between renderer and main.
 * Channels and methods are added as features land in M2+.
 */
export interface AppApi {
  /** App version surfaced from main → renderer at boot. */
  getAppVersion(): Promise<string>;
}

declare global {
  interface Window {
    api: AppApi;
  }
}

export {};
