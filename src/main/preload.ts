import type { AppApi } from '@shared/ipc';
import type { Settings } from '@shared/settings';
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:update', patch),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),

  hasApiKey: () => ipcRenderer.invoke('secure:hasKey'),
  setApiKey: (key: string) => ipcRenderer.invoke('secure:setKey', key),
  clearApiKey: () => ipcRenderer.invoke('secure:clearKey'),

  pickFolder: (opts: { title?: string; defaultPath?: string }) =>
    ipcRenderer.invoke('dialog:pickFolder', opts),
};

contextBridge.exposeInMainWorld('api', api as AppApi);
