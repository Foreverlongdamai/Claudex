// 把主进程的能力以 window.claudex 的形式安全地暴露给界面（contextIsolation + sandbox）。
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { API_METHODS, channel, EVENT_CHANNEL } from '../shared/ipc';
import type { ClaudexApi, ConvEvent } from '../shared/types';

const invokers = Object.fromEntries(
  API_METHODS.map(m => [m, (...args: unknown[]) => ipcRenderer.invoke(channel(m), ...args)])
) as Omit<ClaudexApi, 'onEvent'>;

const api: ClaudexApi = {
  ...invokers,
  onEvent(cb) {
    const handler = (_e: IpcRendererEvent, ev: ConvEvent) => cb(ev);
    ipcRenderer.on(EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, handler);
  }
};

contextBridge.exposeInMainWorld('claudex', api);
