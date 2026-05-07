import type { AppApi } from '@shared/ipc';
import { contextBridge, ipcRenderer } from 'electron';

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const api: AppApi = {
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
} as AppApi;

contextBridge.exposeInMainWorld('api', api);
