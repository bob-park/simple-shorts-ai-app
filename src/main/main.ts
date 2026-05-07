import type { Settings } from '@shared/settings';
import { BrowserWindow, app, dialog, ipcMain, safeStorage, session, shell } from 'electron';
import Store from 'electron-store';
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SecureStorage } from './infra/SecureStorage';
import { SettingsStore } from './infra/SettingsStore';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const isDev = !app.isPackaged;

let settingsStore: SettingsStore;
let secureStorage: SecureStorage;

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

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
