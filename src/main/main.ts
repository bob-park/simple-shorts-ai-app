import type { Settings } from '@shared/settings';
import { sanitizeFilename } from '@shared/youtube';
import { BrowserWindow, app, dialog, ipcMain, safeStorage, session, shell } from 'electron';
import Store from 'electron-store';
import { spawn } from 'node:child_process';
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import youtubeDl from 'youtube-dl-exec';

import { SecureStorage } from './infra/SecureStorage';
import { SettingsStore } from './infra/SettingsStore';
import { type DownloadHandle, YouTubeService } from './services/YouTubeService';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const isDev = !app.isPackaged;

let settingsStore: SettingsStore;
let secureStorage: SecureStorage;
let youtubeService: YouTubeService;
let activeDownload: DownloadHandle | null = null;
let downloadStarting = false;

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

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
