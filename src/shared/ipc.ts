import type { Settings } from './settings';
import type { DownloadProgress, VideoMeta } from './youtube';

/**
 * Typed IPC bridge between renderer and main.
 * Channels and methods are added as features land.
 */
export interface AppApi {
  /** App version surfaced from main → renderer at boot. */
  getAppVersion(): Promise<string>;

  /** Settings persistence (electron-store backed). */
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  resetSettings(): Promise<Settings>;

  /** OpenRouter API key (safeStorage backed; never echoed back in plaintext). */
  hasApiKey(): Promise<boolean>;
  setApiKey(key: string): Promise<void>;
  clearApiKey(): Promise<void>;

  /** Native folder picker; returns selected absolute path or null on cancel. */
  pickFolder(opts: { title?: string; defaultPath?: string }): Promise<string | null>;

  /** Fetches title/duration/thumbnail/etc. for a YouTube URL via yt-dlp. */
  fetchVideoPreview(url: string): Promise<VideoMeta>;
  /** Starts a download. Resolves to the absolute output path on success. */
  downloadVideo(url: string): Promise<{ outputPath: string }>;
  /** Cancels the active download (no-op if none in flight). */
  cancelDownload(): Promise<void>;
  /** Subscribe to download progress events. Returns an unsubscribe function. */
  onDownloadProgress(callback: (p: DownloadProgress) => void): () => void;

  /** Reveal a file in the OS file manager (Finder / Explorer). */
  revealInFolder(absolutePath: string): Promise<void>;
}

declare global {
  interface Window {
    api: AppApi;
  }
}

export {};
