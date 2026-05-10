import type { ExtractProgress } from './extract';
import type { HighlightSet } from './highlight';
import type { HistoryListQuery, JobDetail, JobSummary } from './history';
import type { RenderProgress, RenderResult } from './render';
import type { ResumeSnapshot } from './resume';
import type { Settings } from './settings';
import type { SetupProgress, SetupStatus } from './setup';
import type { TranscribeProgress } from './transcribe';
import type { Transcript } from './transcript';
import type { DownloadProgress, VideoMeta } from './youtube';

export interface AppApi {
  getAppVersion(): Promise<string>;

  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  resetSettings(): Promise<Settings>;

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
   * sibling `<audioPath>.transcript.json`, sends segments to the local Gemma
   * model via the Python sidecar, writes `<audioPath>.highlights.json`. On
   * first call, automatically downloads the model GGUF (~2.5GB) — progress
   * events come through `onExtractProgress` with `phase: 'download'`.
   */
  extractHighlights(audioPath: string): Promise<{ highlightsPath: string; highlightSet: HighlightSet }>;
  /** Cancel the active highlight extraction (no-op if none). */
  cancelExtract(): Promise<void>;
  /** Subscribe to extract progress notifications. Returns unsubscribe. */
  onExtractProgress(callback: (p: ExtractProgress) => void): () => void;

  /** Detect prior pipeline run by videoId. Returns null if none. */
  resumeDetect(videoId: string): Promise<ResumeSnapshot | null>;
  /** Build snapshot from a known sourcePath (used by History "이어서 작업"). */
  resumeHydrate(sourcePath: string): Promise<ResumeSnapshot | null>;

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

  setupStatus(): Promise<SetupStatus>;
  setupRun(): Promise<void>;
  onSetupProgress(callback: (p: SetupProgress) => void): () => void;

  /** Status of the local Gemma model file on disk. */
  llmModelStatus(): Promise<{ exists: boolean; sizeBytes: number; loaded: boolean }>;
  /** Manually trigger a (re-)download of the local model. Streams progress via `onLlmDownloadProgress`. */
  llmDownloadModel(): Promise<void>;
  /** Subscribe to download progress for the manual `llmDownloadModel` flow. */
  onLlmDownloadProgress(callback: (p: { processed: number; total: number }) => void): () => void;

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
