import type { ExtractProgress } from '@shared/extract';
import type { HistoryListQuery } from '@shared/history';
import type { AppApi } from '@shared/ipc';
import type { RenderProgress } from '@shared/render';
import type { Settings } from '@shared/settings';
import type { TranscribeProgress } from '@shared/transcribe';
import type { DownloadProgress } from '@shared/youtube';
import { contextBridge, ipcRenderer } from 'electron';

const api: AppApi = {
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:update', patch),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),

  llmModelStatus: () => ipcRenderer.invoke('llm:modelStatus'),
  llmDownloadModel: () => ipcRenderer.invoke('llm:downloadModel'),
  onLlmDownloadProgress: (callback: (p: { processed: number; total: number }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: { processed: number; total: number }) => callback(data);
    ipcRenderer.on('llm:downloadProgress', handler);
    return () => {
      ipcRenderer.off('llm:downloadProgress', handler);
    };
  },

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

  extractHighlights: (audioPath: string) => ipcRenderer.invoke('extract:run', audioPath),
  cancelExtract: () => ipcRenderer.invoke('extract:cancel'),
  onExtractProgress: (callback: (p: ExtractProgress) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: ExtractProgress) => callback(data);
    ipcRenderer.on('extract:progress', handler);
    return () => {
      ipcRenderer.off('extract:progress', handler);
    };
  },

  renderShorts: (audioPath: string) => ipcRenderer.invoke('render:run', audioPath),
  cancelRender: () => ipcRenderer.invoke('render:cancel'),
  onRenderProgress: (callback: (p: RenderProgress) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: RenderProgress) => callback(data);
    ipcRenderer.on('render:progress', handler);
    return () => {
      ipcRenderer.off('render:progress', handler);
    };
  },

  historyList: (query: HistoryListQuery) => ipcRenderer.invoke('history:list', query),
  historyGetDetail: (jobId: string) => ipcRenderer.invoke('history:getDetail', jobId),
  historyDelete: (jobId: string) => ipcRenderer.invoke('history:delete', jobId),

  revealInFolder: (absolutePath: string) => ipcRenderer.invoke('shell:reveal', absolutePath),
  openPath: (absolutePath: string) => ipcRenderer.invoke('shell:openPath', absolutePath),
};

contextBridge.exposeInMainWorld('api', api);
