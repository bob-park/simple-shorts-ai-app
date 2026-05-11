import { HighlightSetSchema } from '@shared/highlight';
import { HistoryListQuerySchema } from '@shared/history';
import type { Settings } from '@shared/settings';
import { TranscriptSchema, type Word } from '@shared/transcript';
import { VideoMetaSchema, sanitizeFilename } from '@shared/youtube';
import Database from 'better-sqlite3';
import { BrowserWindow, Notification, app, dialog, ipcMain, powerSaveBlocker, session, shell } from 'electron';
import Store from 'electron-store';
import { execFile, spawn } from 'node:child_process';
import { existsSync, promises as fsPromises } from 'node:fs';
import { basename, extname, join, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import youtubeDl from 'youtube-dl-exec';

import { FfmpegRunner } from './infra/FfmpegRunner';
import { HistoryRepo } from './infra/HistoryRepo';
import { PythonSidecar } from './infra/PythonSidecar';
import { resolveRuntimePaths as resolveRuntimePathsImpl, type RuntimePaths } from './infra/runtimePaths';
import { SettingsStore } from './infra/SettingsStore';
import { SidecarLlmClient } from './infra/SidecarLlmClient';
import { HighlightService } from './services/HighlightService';
import { HistoryService } from './services/HistoryService';
import { RenderService } from './services/RenderService';
import { ResumeService } from './services/ResumeService';
import { SetupWizardService } from './services/SetupWizardService';
import { ThumbnailService } from './services/ThumbnailService';
import { TrackingService } from './services/TrackingService';
import { TranscribeService } from './services/TranscribeService';
import { type DownloadHandle, YouTubeService } from './services/YouTubeService';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const isDev = !app.isPackaged;

function resolveRuntimePaths(): RuntimePaths {
  return resolveRuntimePathsImpl({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath('userData'),
    repoRoot: resolvePath(__dirname, '../../'),
    platform: process.platform,
    arch: process.arch,
    fileExists: existsSync,
  });
}

// Local LLM model identity — single source of truth for both extract:run's
// on-demand download and Settings re-download.
const LLM_MODEL_DIR = 'models';
const LLM_MODEL_FILENAME = 'gemma-3-4b-it-Q4_K_M.gguf';
const LLM_MODEL_REPO = 'unsloth/gemma-3-4b-it-GGUF';

let settingsStore: SettingsStore;
let youtubeService: YouTubeService;
let activeDownload: DownloadHandle | null = null;
let downloadStarting = false;
let pythonSidecar: PythonSidecar | null = null;
let transcribeService: TranscribeService | null = null;
let transcribeProgressUnsub: (() => void) | null = null;

let sidecarLlmClient: SidecarLlmClient | null = null;
let highlightService: HighlightService | null = null;
let extractProgressUnsub: (() => void) | null = null;
let extractInFlight = false;

let ffmpegRunner: FfmpegRunner | null = null;
let renderService: RenderService | null = null;
let renderProgressUnsub: (() => void) | null = null;
let renderInFlight = false;
let trackingService: TrackingService | null = null;

let historyRepo: HistoryRepo | null = null;
let historyService: HistoryService | null = null;
let resumeService: ResumeService | null = null;
let setupWizard: SetupWizardService | null = null;

/**
 * Wrap a long-running IPC handler so macOS doesn't App-Nap the app (and its
 * sidecar children) onto Efficiency cores while it runs. Without this,
 * compute-heavy stages (STT, LLM extract, render) end up scheduled at
 * background QoS and observed CPU drops to ~0.6 of a core even when the
 * workload is multi-threaded — packaged GUI apps get this treatment more
 * aggressively than CLI-launched dev builds.
 *
 * `prevent-app-suspension` is the lighter of the two power-save blockers —
 * it does NOT keep the screen awake, only stops the system from suspending
 * the app process tree.
 */
async function withPowerSaveBlocker<T>(fn: () => Promise<T>): Promise<T> {
  const id = powerSaveBlocker.start('prevent-app-suspension');
  try {
    return await fn();
  } finally {
    powerSaveBlocker.stop(id);
  }
}

/**
 * Show a desktop notification for a completed pipeline stage. Skipped when
 * the app window is currently focused — if the user is watching the UI they
 * already see the result, so a notification would just be noise. Click on
 * the notification focuses the window.
 */
function notifyStageComplete(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed() && win.isFocused()) return;
  const n = new Notification({ title, body, silent: false });
  n.on('click', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  n.show();
}

function setupContentSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = [
      "default-src 'self'",
      // Vite dev injects inline scripts; allow only in dev.
      `script-src 'self'${isDev ? " 'unsafe-inline' 'unsafe-eval'" : ''}`,
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "img-src 'self' data: https:",
      `connect-src 'self'${isDev ? ' ws://localhost:5173 http://localhost:5173' : ''}`,
      "object-src 'none'",
      "base-uri 'self'",
    ].join('; ');
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // External links open in the OS browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return win;
}

function getTranscribeService(): TranscribeService {
  if (transcribeService) return transcribeService;
  const paths = resolveRuntimePaths();
  const modelsDir = join(app.getPath('userData'), 'whisper-models');
  pythonSidecar = new PythonSidecar({
    spawn,
    command: paths.sidecarSpawn.command,
    args: paths.sidecarSpawn.args,
    cwd: paths.sidecarCwd,
    env: { HF_HOME: modelsDir, ...paths.sidecarEnv },
  });
  transcribeService = new TranscribeService(pythonSidecar);

  transcribeProgressUnsub = pythonSidecar.onProgress((p) => {
    if (p.jobId === 'llm-download') return; // routed by SidecarLlmClient instead
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send('transcribe:progress', p);
    }
  });

  return transcribeService;
}

function getHighlightService(): HighlightService {
  if (highlightService) return highlightService;
  // Ensure the sidecar exists — same instance reused across transcribe/track/llm.
  if (!pythonSidecar) {
    getTranscribeService();
  }
  if (!pythonSidecar) {
    throw new Error('PythonSidecar failed to initialise');
  }
  const modelPath = join(app.getPath('userData'), LLM_MODEL_DIR, LLM_MODEL_FILENAME);
  sidecarLlmClient = new SidecarLlmClient(pythonSidecar, modelPath);
  highlightService = new HighlightService(sidecarLlmClient);
  extractProgressUnsub = highlightService.onProgress((p) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send('extract:progress', p);
    }
  });
  return highlightService;
}

function getRenderService(): RenderService {
  if (renderService) return renderService;
  const paths = resolveRuntimePaths();
  ffmpegRunner = new FfmpegRunner({
    spawn,
    // existsSync filters out the 'ffmpeg' PATH-name string (which is not an
    // absolute path) and keeps the bundled libass-enabled binary when present
    // — required in BOTH dev and packaged mode because Homebrew's ffmpeg is
    // built without --enable-libass and would silently drop `subtitles=`.
    command: existsSync(paths.ffmpegBinary) ? paths.ffmpegBinary : 'ffmpeg',
  });
  // Tracking goes through the same Python sidecar that owns transcribe (lazy
  // boot on first call). Reuse the existing PythonSidecar instance if it's
  // already been spun up by transcribe; otherwise this triggers it.
  if (!pythonSidecar) {
    getTranscribeService();
  }
  if (!pythonSidecar) {
    throw new Error('PythonSidecar failed to initialise');
  }
  trackingService = new TrackingService(pythonSidecar);
  renderService = new RenderService(ffmpegRunner, { tracker: trackingService });
  renderProgressUnsub = renderService.onProgress((p) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send('render:progress', p);
    }
  });
  return renderService;
}

function getHistoryRepo(): HistoryRepo {
  if (historyRepo) return historyRepo;
  const dbPath = join(app.getPath('userData'), 'history.db');
  historyRepo = new HistoryRepo(new Database(dbPath));
  return historyRepo;
}

function getHistoryService(): HistoryService {
  if (historyService) return historyService;
  if (!ffmpegRunner) {
    const paths = resolveRuntimePaths();
    ffmpegRunner = new FfmpegRunner({
      spawn,
      // existsSync filters out the 'ffmpeg' PATH-name string (which is not an
    // absolute path) and keeps the bundled libass-enabled binary when present
    // — required in BOTH dev and packaged mode because Homebrew's ffmpeg is
    // built without --enable-libass and would silently drop `subtitles=`.
    command: existsSync(paths.ffmpegBinary) ? paths.ffmpegBinary : 'ffmpeg',
    });
  }
  const thumbnails = new ThumbnailService(ffmpegRunner);
  historyService = new HistoryService({
    repo: getHistoryRepo(),
    thumbs: thumbnails,
    thumbsDir: join(app.getPath('userData'), 'thumbs'),
  });
  return historyService;
}

function getResumeService(): ResumeService {
  if (resumeService) return resumeService;
  resumeService = new ResumeService(settingsStore, fsPromises);
  return resumeService;
}

function getSetupWizard(): SetupWizardService {
  if (setupWizard) return setupWizard;
  const paths = resolveRuntimePaths();
  setupWizard = new SetupWizardService({
    uvBinary: paths.uvBinary,
    pythonRuntime: paths.pythonRuntime,
    venvPath: paths.venvPath,
    venvPythonBinary: paths.venvPythonBinary,
    requirementsPath: paths.requirementsPath,
    spawn,
    fs: { access: fsPromises.access },
  });
  setupWizard.onProgress((p) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send('setup:progress', p);
    }
  });
  return setupWizard;
}

void app.whenReady().then(() => {
  setupContentSecurityPolicy();

  // Storage init
  const electronStore = new Store<Settings>();
  settingsStore = new SettingsStore(electronStore, {
    downloads: app.getPath('downloads'),
    documents: app.getPath('documents'),
  });
  const runtimePathsBoot = resolveRuntimePaths();
  // yt-dlp resolution:
  //
  // Packaged mode — use the standalone PyInstaller binary bundled at
  // Resources/yt-dlp (see scripts/fetch-runtime.ts). It has its own embedded
  // Python, so it doesn't depend on system Python. (youtube-dl-exec's bundled
  // yt-dlp is a Python zipapp that shells out to system python3, which on
  // macOS is 3.9 from CommandLineTools — too old for current yt-dlp.)
  //
  // Dev mode — fall back to youtube-dl-exec's bundled zipapp (the dev
  // shell PATH usually has python 3.10+ via mise/asdf). Rewrite the asar
  // path just in case the dev mode happens to be launched packaged.
  //
  // We invoke via execFile() rather than youtube-dl-exec's default function
  // because that pipes through tinyspawn, which splits the binary path on
  // whitespace (tinyspawn/src/index.js:45) — broken for paths like
  // "/Applications/Shorts AI.app/...".
  const ytdlpFromYdlExec = (youtubeDl as unknown as { constants: { YOUTUBE_DL_PATH: string } }).constants
    .YOUTUBE_DL_PATH;
  const ytdlpBinaryPath = app.isPackaged
    ? runtimePathsBoot.ytdlpBinary
    : ytdlpFromYdlExec.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
  console.log('[main] yt-dlp binary path:', ytdlpBinaryPath);
  const execFileP = promisify(execFile);
  const ytdlpFn = async (url: string, flags: Record<string, unknown>) => {
    const args: string[] = [url];
    if (flags.dumpSingleJson) args.push('--dump-single-json');
    if (flags.skipDownload) args.push('--skip-download');
    if (flags.noWarnings) args.push('--no-warnings');
    const { stdout } = await execFileP(ytdlpBinaryPath, args, {
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  };
  youtubeService = new YouTubeService({
    youtubeDl: ytdlpFn as never,
    spawn: spawn as never,
    binaryPath: ytdlpBinaryPath,
    // yt-dlp's --ffmpeg-location wants a path, not a name — passing 'ffmpeg'
    // would resolve it relative to CWD, not search PATH. Only pass it in
    // packaged mode where we have an absolute bundled-ffmpeg path; in dev,
    // let yt-dlp do its own PATH lookup.
    ffmpegLocation: app.isPackaged ? runtimePathsBoot.ffmpegBinary : undefined,
  });

  // IPC handlers
  ipcMain.handle('app:getVersion', () => app.getVersion());

  ipcMain.handle('settings:get', () => settingsStore.get());
  ipcMain.handle('settings:update', (_e, patch: Partial<Settings>) => settingsStore.update(patch));
  ipcMain.handle('settings:reset', () => settingsStore.reset());

  ipcMain.handle('dialog:pickFolder', async (_e, opts: { title?: string; defaultPath?: string }) => {
    const result = await dialog.showOpenDialog({
      title: opts.title,
      defaultPath: opts.defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('youtube:fetchPreview', (_e, url: string) => youtubeService.fetchMeta(url));

  ipcMain.handle('youtube:download', (_e, url: string) => withPowerSaveBlocker(async () => {
    // Synchronous lock: prevents a second invocation from passing the guard
    // while we await fetchMeta below (the activeDownload assignment was async).
    if (activeDownload || downloadStarting) {
      throw new Error('A download is already in progress');
    }
    downloadStarting = true;
    let handle: DownloadHandle | null = null;
    let metaTitle = '';
    try {
      const settings = settingsStore.get();
      const meta = await youtubeService.fetchMeta(url);
      metaTitle = meta.title;
      // Filename = sanitized title (max 20 chars), with the video id as a
      // safety fallback if sanitization strips the title to nothing.
      const stem = sanitizeFilename(meta.title, 20) || meta.id;
      const outputStem = join(settings.paths.downloads, stem);
      handle = youtubeService.download(url, outputStem, { videoId: meta.id });
      activeDownload = handle;
      downloadStarting = false; // handle now owns the lock
      handle.onProgress((p) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win && !win.isDestroyed()) {
          win.webContents.send('download:progress', p);
        }
      });
      const result = await handle.done;
      // M9: persist the video metadata next to the source so render can build
      // a history row. Keep it sibling to the .transcript.json / .highlights.json
      // artifacts the later milestones already write.
      try {
        const metaPath = `${result.outputPath}.meta.json`;
        await fsPromises.writeFile(
          metaPath,
          JSON.stringify({ ...meta, url, downloadedAt: new Date().toISOString() }, null, 2),
          'utf8',
        );
      } catch (e) {
        // Non-fatal — history record will fall back to a stub if missing.
        process.stderr.write(`[m9] failed to write meta.json: ${(e as Error).message}\n`);
      }
      notifyStageComplete('다운로드 완료', metaTitle || basename(result.outputPath));
      return { outputPath: result.outputPath };
    } catch (e) {
      notifyStageComplete('다운로드 실패', `${metaTitle ? `${metaTitle}: ` : ''}${(e as Error).message}`);
      throw e;
    } finally {
      activeDownload = null;
      downloadStarting = false; // also clears on early throw before handle was set
    }
  }));

  ipcMain.handle('youtube:cancel', () => {
    activeDownload?.cancel();
  });

  ipcMain.handle('shell:reveal', (_e, absolutePath: string) => {
    shell.showItemInFolder(absolutePath);
  });

  ipcMain.handle('transcribe:run', (_e, audioPath: string) => withPowerSaveBlocker(async () => {
    const fileLabel = basename(audioPath);
    try {
      const service = getTranscribeService();
      const settings = settingsStore.get();
      const transcript = await service.transcribe(audioPath, {
        model: settings.whisper.model,
        language: settings.whisper.language,
      });
      const transcriptPath = `${audioPath}.transcript.json`;
      await fsPromises.writeFile(transcriptPath, JSON.stringify(transcript, null, 2), 'utf8');
      notifyStageComplete('자막 추출 완료', fileLabel);
      return { transcriptPath, transcript };
    } catch (e) {
      notifyStageComplete('자막 추출 실패', `${fileLabel}: ${(e as Error).message}`);
      throw e;
    }
  }));

  ipcMain.handle('transcribe:cancel', async () => {
    if (transcribeService) await transcribeService.cancel();
  });

  ipcMain.handle('sidecar:health', async () => {
    const service = getTranscribeService();
    return service.health();
  });

  ipcMain.handle('shell:openPath', async (_e, absolutePath: string) => {
    await shell.openPath(absolutePath);
  });

  ipcMain.handle('extract:run', (_e, audioPath: string) => withPowerSaveBlocker(async () => {
    if (extractInFlight) {
      throw new Error('An extraction is already in progress');
    }
    extractInFlight = true;
    const fileLabel = basename(audioPath);
    try {
      const transcriptPath = `${audioPath}.transcript.json`;
      const transcriptRaw = await fsPromises.readFile(transcriptPath, 'utf8');
      const transcript = TranscriptSchema.parse(JSON.parse(transcriptRaw));

      const service = getHighlightService();

      // Download model on demand if not yet present.
      const status = await sidecarLlmClient!.modelStatus();
      if (!status.exists) {
        await fsPromises.mkdir(join(app.getPath('userData'), LLM_MODEL_DIR), { recursive: true });
        await sidecarLlmClient!.downloadModel({ repo: LLM_MODEL_REPO, filename: LLM_MODEL_FILENAME }, (p) => {
          const win = BrowserWindow.getAllWindows()[0];
          if (win && !win.isDestroyed()) {
            win.webContents.send('extract:progress', {
              jobId: audioPath,
              chunkIndex: 0,
              chunkTotal: 0,
              phase: 'download' as const,
              downloadedBytes: p.processed,
              totalBytes: p.total,
            });
          }
        });
      }

      const settings = settingsStore.get();
      const highlightSet = await service.extract({
        transcript,
        audioPath,
        count: settings.shorts.defaultCount,
        minSec: settings.shorts.minSec,
        maxSec: settings.shorts.maxSec,
      });
      const highlightsPath = `${audioPath}.highlights.json`;
      await fsPromises.writeFile(highlightsPath, JSON.stringify(highlightSet, null, 2), 'utf8');
      notifyStageComplete('하이라이트 추출 완료', `${fileLabel} · ${highlightSet.highlights.length}개`);
      return { highlightsPath, highlightSet };
    } catch (e) {
      notifyStageComplete('하이라이트 추출 실패', `${fileLabel}: ${(e as Error).message}`);
      throw e;
    } finally {
      extractInFlight = false;
    }
  }));

  ipcMain.handle('extract:cancel', () => {
    // M11: local LLM chat is uncancellable once dispatched.
    // The renderer's "취소" button is a no-op for now.
  });

  ipcMain.handle('resume:detect', (_e, videoId: string) => getResumeService().detect(videoId));
  ipcMain.handle('resume:hydrate', (_e, sourcePath: string) => getResumeService().hydrate(sourcePath));

  ipcMain.handle('llm:downloadModel', async () => {
    getHighlightService(); // ensures sidecarLlmClient is initialized
    if (!sidecarLlmClient) throw new Error('SidecarLlmClient not initialized');
    const modelPath = join(app.getPath('userData'), LLM_MODEL_DIR, LLM_MODEL_FILENAME);
    await fsPromises.unlink(modelPath).catch(() => undefined);
    await fsPromises.mkdir(join(app.getPath('userData'), LLM_MODEL_DIR), { recursive: true });
    await sidecarLlmClient.downloadModel({ repo: LLM_MODEL_REPO, filename: LLM_MODEL_FILENAME }, (p) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        win.webContents.send('llm:downloadProgress', { processed: p.processed, total: p.total });
      }
    });
  });

  ipcMain.handle('llm:modelStatus', async () => {
    getHighlightService(); // ensures sidecarLlmClient is initialized
    if (!sidecarLlmClient) throw new Error('SidecarLlmClient not initialized');
    return sidecarLlmClient.modelStatus();
  });

  ipcMain.handle('render:run', (_e, audioPath: string) => withPowerSaveBlocker(async () => {
    if (renderInFlight) {
      throw new Error('A render is already in progress');
    }
    renderInFlight = true;
    const fileLabel = basename(audioPath);
    try {
      const highlightsPath = `${audioPath}.highlights.json`;
      let raw: string;
      try {
        raw = await fsPromises.readFile(highlightsPath, 'utf8');
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          throw new Error(`No highlights found at ${highlightsPath}`);
        }
        throw e;
      }
      const highlightSet = HighlightSetSchema.parse(JSON.parse(raw));

      const settings = settingsStore.get();
      const sourceStem = basename(audioPath, extname(audioPath));
      const outputDir = join(settings.paths.outputs, sourceStem);
      await fsPromises.mkdir(outputDir, { recursive: true });

      // Subtitles are sourced from the sibling transcript.json. If subtitles are
      // disabled in settings OR the transcript file is missing, we render without
      // subtitles (the M7 behaviour). Read errors are non-fatal — render proceeds.
      let transcriptWords: Word[] | undefined;
      if (settings.subtitles.enabled) {
        try {
          const transcriptRaw = await fsPromises.readFile(`${audioPath}.transcript.json`, 'utf8');
          const transcript = TranscriptSchema.parse(JSON.parse(transcriptRaw));
          transcriptWords = transcript.words;
        } catch {
          // No transcript or unreadable — silently render without subtitles.
          transcriptWords = undefined;
        }
      }

      const service = getRenderService();
      const renderResult = await service.render({
        sourcePath: audioPath,
        outputDir,
        highlights: highlightSet.highlights,
        transcriptWords,
        subtitleOptions:
          settings.subtitles.enabled && transcriptWords
            ? {
                fontFamily: settings.subtitles.fontFamily,
                fontSize: settings.subtitles.fontSize,
                fillColor: settings.subtitles.fillColor,
                outlineColor: settings.subtitles.outlineColor,
                position: settings.subtitles.position,
                titleFontSize: settings.subtitles.titleFontSize,
                titleFontWeight: settings.subtitles.titleFontWeight,
              }
            : undefined,
      });

      // M9: persist to history. Best-effort — render result is returned even if
      // persistence fails (avoids losing the user's render to a DB error).
      try {
        const metaPath = `${audioPath}.meta.json`;
        const metaRaw = await fsPromises.readFile(metaPath, 'utf8');
        const meta = VideoMetaSchema.parse(JSON.parse(metaRaw));
        await getHistoryService().recordJob({
          meta,
          sourcePath: audioPath,
          highlightSet,
          renderResult,
          whisperModel: settings.whisper.model,
        });
      } catch (e) {
        process.stderr.write(`[m9] failed to record history: ${(e as Error).message}\n`);
      }

      const okCount = renderResult.results.filter((r) => r.status === 'done').length;
      const failed = renderResult.results.length - okCount;
      const body = failed === 0 ? `${fileLabel} · ${okCount}개` : `${fileLabel} · ${okCount}개 완료, ${failed}개 실패/취소`;
      notifyStageComplete('렌더링 완료', body);
      return renderResult;
    } catch (e) {
      notifyStageComplete('렌더링 실패', `${fileLabel}: ${(e as Error).message}`);
      throw e;
    } finally {
      renderInFlight = false;
    }
  }));

  ipcMain.handle('render:cancel', () => {
    renderService?.cancel();
  });

  ipcMain.handle('history:list', (_e, query: unknown) => {
    const parsed = HistoryListQuerySchema.parse(query);
    return getHistoryRepo().listSummaries(parsed);
  });

  ipcMain.handle('history:getDetail', (_e, jobId: string) => {
    const repo = getHistoryRepo();
    const job = repo.getJob(jobId);
    if (!job) return null;
    const shorts = repo.getShortsByJob(jobId);
    return { job, shorts };
  });

  ipcMain.handle('history:delete', async (_e, jobId: string) => {
    // Spec promises "delete + thumbnails" — read paths first, then delete the
    // DB rows, then unlink the PNG files (best-effort; missing files = OK).
    const repo = getHistoryRepo();
    const shorts = repo.getShortsByJob(jobId);
    repo.deleteJob(jobId);
    for (const s of shorts) {
      if (s.thumbPath) {
        await fsPromises.unlink(s.thumbPath).catch(() => undefined);
      }
    }
  });

  ipcMain.handle('setup:status', () => getSetupWizard().status());
  ipcMain.handle('setup:run', () => getSetupWizard().run());

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  transcribeProgressUnsub?.();
  transcribeProgressUnsub = null;
  pythonSidecar?.shutdown();
  pythonSidecar = null;
  transcribeService = null;
  extractProgressUnsub?.();
  extractProgressUnsub = null;
  highlightService = null;
  sidecarLlmClient = null;
  renderProgressUnsub?.();
  renderProgressUnsub = null;
  renderService?.cancel();
  renderService = null;
  ffmpegRunner = null;
  trackingService = null;
  historyRepo?._db.close();
  historyRepo = null;
  historyService = null;
  resumeService = null;
  setupWizard = null;
  if (process.platform !== 'darwin') app.quit();
});
