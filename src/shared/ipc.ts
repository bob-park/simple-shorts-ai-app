import type { Settings } from './settings';
import type { TranscribeProgress } from './transcribe';
import type { Transcript } from './transcript';
import type { DownloadProgress, VideoMeta } from './youtube';

export interface AppApi {
  getAppVersion(): Promise<string>;

  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  resetSettings(): Promise<Settings>;

  hasApiKey(): Promise<boolean>;
  setApiKey(key: string): Promise<void>;
  clearApiKey(): Promise<void>;

  pickFolder(opts: { title?: string; defaultPath?: string }): Promise<string | null>;

  fetchVideoPreview(url: string): Promise<VideoMeta>;
  downloadVideo(url: string): Promise<{ outputPath: string }>;
  cancelDownload(): Promise<void>;
  onDownloadProgress(callback: (p: DownloadProgress) => void): () => void;

  /** Transcribe an existing audio/video file via the Python sidecar. */
  transcribeFile(audioPath: string): Promise<{ transcriptPath: string; transcript: Transcript }>;
  /** Cancel the active transcription (no-op if none). */
  cancelTranscribe(): Promise<void>;
  /** Subscribe to transcribe progress notifications. Returns unsubscribe. */
  onTranscribeProgress(callback: (p: TranscribeProgress) => void): () => void;
  /** Health-check the Python sidecar (will boot it lazily if needed). */
  sidecarHealth(): Promise<{ ok: boolean; modelsLoaded: string[] }>;

  revealInFolder(absolutePath: string): Promise<void>;
  /** Open a file with the OS default app (e.g., transcript.json → text editor). */
  openPath(absolutePath: string): Promise<void>;
}

declare global {
  interface Window {
    api: AppApi;
  }
}

export {};
