import { HighlightSetSchema } from '@shared/highlight';
import type { Settings } from '@shared/settings';
import { TranscriptSchema } from '@shared/transcript';
import { sanitizeFilename } from '@shared/youtube';
import { BrowserWindow, app, dialog, ipcMain, safeStorage, session, shell } from 'electron';
import Store from 'electron-store';
import { spawn } from 'node:child_process';
import { promises as fsPromises } from 'node:fs';
import { basename, extname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import youtubeDl from 'youtube-dl-exec';

import { FfmpegRunner } from './infra/FfmpegRunner';
import { OpenRouterClient } from './infra/OpenRouterClient';
import { PythonSidecar } from './infra/PythonSidecar';
import { SecureStorage } from './infra/SecureStorage';
import { SettingsStore } from './infra/SettingsStore';
import { HighlightService } from './services/HighlightService';
import { RenderService } from './services/RenderService';
import { TranscribeService } from './services/TranscribeService';
import { type DownloadHandle, YouTubeService } from './services/YouTubeService';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const isDev = !app.isPackaged;

let settingsStore: SettingsStore;
let secureStorage: SecureStorage;
let youtubeService: YouTubeService;
let activeDownload: DownloadHandle | null = null;
let downloadStarting = false;
let pythonSidecar: PythonSidecar | null = null;
let transcribeService: TranscribeService | null = null;
let transcribeProgressUnsub: (() => void) | null = null;

let openRouterClient: OpenRouterClient | null = null;
let highlightService: HighlightService | null = null;
let extractProgressUnsub: (() => void) | null = null;
let extractInFlight = false;

let ffmpegRunner: FfmpegRunner | null = null;
let renderService: RenderService | null = null;
let renderProgressUnsub: (() => void) | null = null;
let renderInFlight = false;

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
  const repoRoot = resolvePath(__dirname, '../../');
  const modelsDir = join(app.getPath('userData'), 'whisper-models');
  pythonSidecar = new PythonSidecar({
    spawn,
    command: 'uv',
    args: ['run', 'python', '-m', 'shorts_sidecar'],
    cwd: join(repoRoot, 'sidecar'),
    env: { HF_HOME: modelsDir },
  });
  transcribeService = new TranscribeService(pythonSidecar);

  transcribeProgressUnsub = pythonSidecar.onProgress((p) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send('transcribe:progress', p);
    }
  });

  return transcribeService;
}

function getHighlightService(): HighlightService {
  if (highlightService) return highlightService;
  openRouterClient = new OpenRouterClient();
  highlightService = new HighlightService(openRouterClient);
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
  ffmpegRunner = new FfmpegRunner({ spawn });
  renderService = new RenderService(ffmpegRunner);
  renderProgressUnsub = renderService.onProgress((p) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send('render:progress', p);
    }
  });
  return renderService;
}

void app.whenReady().then(() => {
  setupContentSecurityPolicy();

  // Storage init
  const electronStore = new Store<Settings>();
  settingsStore = new SettingsStore(electronStore, {
    downloads: app.getPath('downloads'),
    documents: app.getPath('documents'),
  });
  secureStorage = new SecureStorage(join(app.getPath('userData'), 'secrets.bin'), safeStorage, fsPromises);

  youtubeService = new YouTubeService({
    youtubeDl: youtubeDl as never,
    spawn: spawn as never,
    // The downloader spawns yt-dlp directly (separate from youtube-dl-exec's
    // default export); without an explicit path it would fall back to
    // PATH lookup and fail with ENOENT in dev. Point it at the bundled binary.
    binaryPath: (youtubeDl as unknown as { constants: { YOUTUBE_DL_PATH: string } }).constants.YOUTUBE_DL_PATH,
  });

  // IPC handlers
  ipcMain.handle('app:getVersion', () => app.getVersion());

  ipcMain.handle('settings:get', () => settingsStore.get());
  ipcMain.handle('settings:update', (_e, patch: Partial<Settings>) => settingsStore.update(patch));
  ipcMain.handle('settings:reset', () => settingsStore.reset());

  ipcMain.handle('secure:hasKey', () => secureStorage.hasKey());
  ipcMain.handle('secure:setKey', (_e, key: string) => secureStorage.setKey(key));
  ipcMain.handle('secure:clearKey', () => secureStorage.clearKey());

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

  ipcMain.handle('youtube:download', async (_e, url: string) => {
    // Synchronous lock: prevents a second invocation from passing the guard
    // while we await fetchMeta below (the activeDownload assignment was async).
    if (activeDownload || downloadStarting) {
      throw new Error('A download is already in progress');
    }
    downloadStarting = true;
    let handle: DownloadHandle | null = null;
    try {
      const settings = settingsStore.get();
      const meta = await youtubeService.fetchMeta(url);
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
      return { outputPath: result.outputPath };
    } finally {
      activeDownload = null;
      downloadStarting = false; // also clears on early throw before handle was set
    }
  });

  ipcMain.handle('youtube:cancel', () => {
    activeDownload?.cancel();
  });

  ipcMain.handle('shell:reveal', (_e, absolutePath: string) => {
    shell.showItemInFolder(absolutePath);
  });

  ipcMain.handle('transcribe:run', async (_e, audioPath: string) => {
    const service = getTranscribeService();
    const settings = settingsStore.get();
    const transcript = await service.transcribe(audioPath, {
      model: settings.whisper.model,
      language: settings.whisper.language,
    });
    const transcriptPath = `${audioPath}.transcript.json`;
    await fsPromises.writeFile(transcriptPath, JSON.stringify(transcript, null, 2), 'utf8');
    return { transcriptPath, transcript };
  });

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

  ipcMain.handle('extract:run', async (_e, audioPath: string) => {
    // Synchronous lock prevents a second invocation from overlapping while we
    // await fs/HighlightService below — concurrent calls would otherwise both
    // construct an AbortController on the singleton service, leaving the first
    // call's signal orphaned and uncancellable.
    if (extractInFlight) {
      throw new Error('An extraction is already in progress');
    }
    extractInFlight = true;
    try {
      const apiKey = await secureStorage.getKey();
      if (!apiKey) {
        throw new Error('OpenRouter API key is not set');
      }
      const transcriptPath = `${audioPath}.transcript.json`;
      const transcriptRaw = await fsPromises.readFile(transcriptPath, 'utf8');
      const transcript = TranscriptSchema.parse(JSON.parse(transcriptRaw));

      const service = getHighlightService();
      const settings = settingsStore.get();
      const highlightSet = await service.extract({
        transcript,
        audioPath,
        apiKey,
        model: settings.llm.model,
        count: settings.shorts.defaultCount,
        minSec: settings.shorts.minSec,
        maxSec: settings.shorts.maxSec,
      });
      const highlightsPath = `${audioPath}.highlights.json`;
      await fsPromises.writeFile(highlightsPath, JSON.stringify(highlightSet, null, 2), 'utf8');
      return { highlightsPath, highlightSet };
    } finally {
      extractInFlight = false;
    }
  });

  ipcMain.handle('extract:cancel', () => {
    highlightService?.cancel();
  });

  ipcMain.handle('render:run', async (_e, audioPath: string) => {
    if (renderInFlight) {
      throw new Error('A render is already in progress');
    }
    renderInFlight = true;
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

      const service = getRenderService();
      return await service.render({
        sourcePath: audioPath,
        outputDir,
        highlights: highlightSet.highlights,
      });
    } finally {
      renderInFlight = false;
    }
  });

  ipcMain.handle('render:cancel', () => {
    renderService?.cancel();
  });

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
  highlightService?.cancel();
  highlightService = null;
  openRouterClient = null;
  renderProgressUnsub?.();
  renderProgressUnsub = null;
  renderService?.cancel();
  renderService = null;
  ffmpegRunner = null;
  if (process.platform !== 'darwin') app.quit();
});
