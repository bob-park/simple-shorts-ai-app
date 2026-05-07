import type { AppApi } from '@shared/ipc';
import { contextBridge, ipcRenderer } from 'electron';

const api: AppApi = {
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
};

contextBridge.exposeInMainWorld('api', api);
