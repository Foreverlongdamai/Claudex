// 主进程和 preload 共用的 IPC 通道名。界面通过 window.claudex 调用，preload 转成 ipcRenderer.invoke / send。
import type { ClaudexApi } from './types';

/** 不需要返回值、调用很频繁的（终端输入、调整大小），用 send */
export const SEND_METHODS = ['termWrite', 'termResize'] as const;
type SendMethod = (typeof SEND_METHODS)[number];
type InvokeMethod = Exclude<keyof ClaudexApi, 'onEvent' | 'onTerm' | SendMethod>;

export const API_METHODS = [
  'getState', 'getEnv', 'listModels', 'pickProject', 'checkProject', 'addProject', 'removeProject',
  'newConversation', 'openConversation', 'deleteConversation', 'send', 'interrupt', 'setMode', 'setModel',
  'respondPermission', 'pendingMcp', 'setMcpApproval', 'listCommands', 'listFiles', 'gitBranch',
  'setPrefs', 'setTheme', 'openExternal', 'listShells', 'termOpen', 'termRestart', 'termKill', 'termRekey'
] as const satisfies ReadonlyArray<InvokeMethod>;

export type ApiMethod = (typeof API_METHODS)[number];
export const channel = (m: ApiMethod | SendMethod) => `claudex:${m}`;
export const EVENT_CHANNEL = 'claudex:event';
export const TERM_CHANNEL = 'claudex:term';
