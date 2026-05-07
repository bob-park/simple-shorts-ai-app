import type { AppApi } from '@shared/ipc';
import type { Settings } from '@shared/settings';
import type { DownloadProgress } from '@shared/youtube';
import { contextBridge, ipcRenderer } from 'electron';

const api: AppApi = {
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:update', patch),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),

  hasApiKey: () => ipcRenderer.invoke('secure:hasKey'),
  setApiKey: (key: string) => ipcRenderer.invoke('secure:setKey', key),
  clearApiKey: () => ipcRenderer.invoke('secure:clearKey'),

  pickFolder: (opts) => ipcRenderer.invoke('dialog:pickFolder', opts),

  fetchVideoPreview: (url: string) => ipcRenderer.invoke('youtube:fetchPreview', url),
  downloadVideo: (url: string) => ipcRenderer.invoke('youtube:download', url),
  cancelDownload: () => ipcRenderer.invoke('youtube:cancel'),
  onDownloadProgress: (callback: (p: DownloadProgress) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: DownloadProgress) => callback(data);
    ipcRenderer.on('download:progress', handler);
    return () => {
      ipcRenderer.off('download:progress', handler);
    };
  },

  revealInFolder: (absolutePath: string) => ipcRenderer.invoke('shell:reveal', absolutePath),
};

contextBridge.exposeInMainWorld('api', api);
