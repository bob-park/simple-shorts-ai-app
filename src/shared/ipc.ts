import type { ExtractProgress } from './extract';
import type { HighlightSet } from './highlight';
import type { HistoryListQuery, JobDetail, JobSummary } from './history';
import type { RenderProgress, RenderResult } from './render';
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

  /**
   * Extract highlight clips from a previously-transcribed video. Reads the
   * sibling `<audioPath>.transcript.json`, sends words to OpenRouter, writes
   * `<audioPath>.highlights.json`. Throws `MissingApiKeyError` (message
   * starts with `OpenRouter API key is not set`) if no key is configured.
   */
  extractHighlights(audioPath: string): Promise<{ highlightsPath: string; highlightSet: HighlightSet }>;
  /** Cancel the active highlight extraction (no-op if none). */
  cancelExtract(): Promise<void>;
  /** Subscribe to extract progress notifications. Returns unsubscribe. */
  onExtractProgress(callback: (p: ExtractProgress) => void): () => void;

  /**
   * Render every highlight in the sibling `<audioPath>.highlights.json` into
   * `<settings.paths.outputs>/<sourceStem>/short_<i>.mp4`. Sequential — one
   * ffmpeg child at a time. Returns the per-clip result list (some clips may
   * have status 'failed' even if the overall call resolves).
   *
   * Throws `Error('No highlights found at <path>')` if the highlights.json
   * does not exist. Throws `Error('ffmpeg is not on PATH')` if the ffmpeg
   * binary cannot be spawned (caught at first attempt).
   */
  renderShorts(audioPath: string): Promise<RenderResult>;
  /** Cancel the active render job (kills current ffmpeg + drops the queue). */
  cancelRender(): Promise<void>;
  /** Subscribe to per-clip progress notifications. Returns unsubscribe. */
  onRenderProgress(callback: (p: RenderProgress) => void): () => void;

  /** Fetch the history list with optional search/sort/filter. */
  historyList(query: HistoryListQuery): Promise<JobSummary[]>;
  /** Fetch full job + shorts detail for the inline drawer. */
  historyGetDetail(jobId: string): Promise<JobDetail | null>;
  /** Permanently delete a job + its shorts + thumbnails. */
  historyDelete(jobId: string): Promise<void>;

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
