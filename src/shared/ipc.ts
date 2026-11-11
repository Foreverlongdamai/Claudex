// 主进程和 preload 共用的 IPC 通道名。界面通过 window.claudex 调用，preload 转成 ipcRenderer.invoke。
import type { ClaudexApi } from './types';

export const API_METHODS = [
  'getState', 'getEnv', 'listModels', 'pickProject', 'checkProject', 'addProject', 'removeProject',
  'newConversation', 'openConversation', 'deleteConversation', 'send', 'interrupt', 'setMode', 'setModel',
  'respondPermission', 'pendingMcp', 'setMcpApproval', 'listCommands', 'listFiles', 'gitBranch',
  'setPrefs', 'setTheme', 'openExternal'
] as const satisfies ReadonlyArray<Exclude<keyof ClaudexApi, 'onEvent'>>;

export type ApiMethod = (typeof API_METHODS)[number];
export const channel = (m: ApiMethod) => `claudex:${m}`;
export const EVENT_CHANNEL = 'claudex:event';
