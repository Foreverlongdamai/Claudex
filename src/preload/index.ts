// 把主进程的能力以 window.claudex 的形式安全地暴露给界面（contextIsolation + sandbox）。
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { API_METHODS, EVENT_CHANNEL, SEND_METHODS, TERM_CHANNEL, channel } from '../shared/ipc';
import type { ClaudexApi, ConvEvent, TermEvent } from '../shared/types';

const invokers = Object.fromEntries(API_METHODS.map(m => [m, (...args: unknown[]) => ipcRenderer.invoke(channel(m), ...args)]));
const senders = Object.fromEntries(SEND_METHODS.map(m => [m, (...args: unknown[]) => ipcRenderer.send(channel(m), ...args)]));

function listen<T>(ch: string, cb: (ev: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, ev: T) => cb(ev);
  ipcRenderer.on(ch, handler);
  return () => ipcRenderer.removeListener(ch, handler);
}

const api = {
  ...invokers,
  ...senders,
  onEvent: (cb: (ev: ConvEvent) => void) => listen(EVENT_CHANNEL, cb),
  onTerm: (cb: (ev: TermEvent) => void) => listen(TERM_CHANNEL, cb)
} as ClaudexApi;

contextBridge.exposeInMainWorld('claudex', api);
