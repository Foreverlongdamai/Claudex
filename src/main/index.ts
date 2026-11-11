// Claudex 主进程：窗口、IPC、对话进程管理。
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_METHODS, channel, EVENT_CHANNEL } from '../shared/ipc';
import type { ClaudexApi, ConvEvent, EnvInfo } from '../shared/types';
import { SessionManager } from './claude/manager';
import { detectGitBash, relayHost, sessionEnv } from './environment';
import { log } from './log';
import { checkProject, gitBranch, listFiles, projectMcpServers } from './projects';
import { Store, samePath } from './store';

// 自动化测试用独立的数据目录，不碰用户真实的数据
if (process.env.CLAUDEX_USER_DATA) app.setPath('userData', process.env.CLAUDEX_USER_DATA);

const here = path.dirname(fileURLToPath(import.meta.url));
const TITLE_BAR = {
  dark: { color: '#1b1b1b', symbolColor: '#ececec' },
  light: { color: '#ffffff', symbolColor: '#0d0d0d' }
} as const;

let win: BrowserWindow | null = null;
let store: Store;
let manager: SessionManager;

const emit = (ev: ConvEvent) => win?.webContents.send(EVENT_CHANNEL, ev);
const gitBash = () => detectGitBash(store.state.prefs.gitBashPath);

/** 没批准过的项目 MCP 服务器一律不启动 */
function disabledMcp(projectPath: string): string[] {
  const approvals = store.mcpApprovals(projectPath);
  return projectMcpServers(projectPath).filter(s => approvals[s.name] !== true).map(s => s.name);
}

function createWindow(): void {
  const theme = store.state.prefs.theme;
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Claudex',
    backgroundColor: TITLE_BAR[theme].color,
    // 隐藏系统标题栏，用自己的顶栏；右上角的最小化/最大化/关闭仍由 Windows 绘制
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...TITLE_BAR[theme], height: 52 },
    webPreferences: {
      preload: path.join(here, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.once('ready-to-show', () => win?.show());
  // 链接一律用系统浏览器打开，App 窗口里不跳转
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url === win?.webContents.getURL()) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(path.join(here, '../renderer/index.html'));
  win.on('closed', () => { win = null; });
}

function registerIpc(): void {
  const api: Omit<ClaudexApi, 'onEvent'> = {
    getState: async () => store.state,
    getEnv: async (): Promise<EnvInfo> => {
      const gb = gitBash();
      const relay = relayHost();
      return {
        appVersion: app.getVersion(),
        gitBashPath: gb.path,
        gitBashSource: gb.source,
        relayHost: relay,
        fastUnavailableReason: relay ? '走中转 API 时不可用（快速模式只在直连 Anthropic API 时可用）' : null
      };
    },
    listModels: () => manager.listModels(),
    pickProject: async () => {
      const r = await dialog.showOpenDialog(win!, { title: '选择项目文件夹', properties: ['openDirectory'] });
      return r.canceled || !r.filePaths[0] ? null : checkProject(r.filePaths[0]);
    },
    checkProject: async p => checkProject(p),
    addProject: async p => { store.addProject(p); return store.state; },
    removeProject: async p => {
      for (const c of store.state.conversations.filter(c => samePath(c.projectPath, p))) manager.delete(c.id);
      store.removeProject(p);
      return store.state;
    },
    newConversation: async p => store.newConversation(p),
    openConversation: id => manager.open(id),
    deleteConversation: async id => { manager.delete(id); store.removeConversation(id); return store.state; },
    send: (id, text, images) => manager.send(id, text, images),
    interrupt: async id => { await manager.interrupt(id); },
    setMode: (id, mode) => manager.setMode(id, mode),
    setModel: (id, model, effort) => manager.setModel(id, model, effort),
    respondPermission: async (id, decision) => { await manager.respond(id, decision); },
    pendingMcp: async p => {
      const approvals = store.mcpApprovals(p);
      return projectMcpServers(p).filter(s => !(s.name in approvals));
    },
    setMcpApproval: async (p, name, approved) => store.setMcpApproval(p, name, approved),
    listCommands: p => manager.listCommands(p),
    listFiles: (p, q) => listFiles(p, q),
    gitBranch: p => gitBranch(p),
    setPrefs: async patch => { store.setPrefs(patch); return store.state; },
    setTheme: async theme => {
      store.setPrefs({ theme });
      win?.setTitleBarOverlay({ ...TITLE_BAR[theme], height: 52 });
      win?.setBackgroundColor(TITLE_BAR[theme].color);
    },
    openExternal: async url => { if (/^https?:/i.test(url)) await shell.openExternal(url); }
  };
  for (const m of API_METHODS) {
    ipcMain.handle(channel(m), (_e, ...args: unknown[]) => (api[m] as (...a: unknown[]) => unknown)(...args));
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  void app.whenReady().then(() => {
    store = new Store();
    manager = new SessionManager(store, {
      env: () => sessionEnv(gitBash().path, app.getVersion()),
      blacklist: () => store.state.prefs.blacklist,
      disabledMcp,
      emit,
      log
    });
    registerIpc();
    createWindow();
    log(`Claudex ${app.getVersion()} 启动；Git Bash：${gitBash().path ?? '没找到'}`);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    manager?.closeAll();
    store?.saveNow();
  });
}
