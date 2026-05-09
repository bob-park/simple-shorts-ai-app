import type { AppApi } from '@shared/ipc';
import type { Settings } from '@shared/settings';
import type { TranscribeProgress } from '@shared/transcribe';
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

  transcribeFile: (audioPath: string) => ipcRenderer.invoke('transcribe:run', audioPath),
  cancelTranscribe: () => ipcRenderer.invoke('transcribe:cancel'),
  onTranscribeProgress: (callback: (p: TranscribeProgress) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: TranscribeProgress) => callback(data);
    ipcRenderer.on('transcribe:progress', handler);
    return () => {
      ipcRenderer.off('transcribe:progress', handler);
    };
  },
  sidecarHealth: () => ipcRenderer.invoke('sidecar:health'),

  revealInFolder: (absolutePath: string) => ipcRenderer.invoke('shell:reveal', absolutePath),
  openPath: (absolutePath: string) => ipcRenderer.invoke('shell:openPath', absolutePath),
};

contextBridge.exposeInMainWorld('api', api);
