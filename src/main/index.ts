// Claudex 主进程：窗口、IPC、对话进程管理。
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_METHODS, channel, EVENT_CHANNEL, GIT_CHANNEL, TERM_CHANNEL } from '../shared/ipc';
import type { ClaudexApi, ConvEvent, EnvInfo } from '../shared/types';
import { SessionManager } from './claude/manager';
import { writeCommitMessage } from './commitMessage';
import { detectGitBash, relayHost, sessionEnv } from './environment';
import * as git from './git';
import { log } from './log';
import { checkProject, gitBranch, listFiles, projectMcpServers } from './projects';
import { ReviewManager } from './review';
import * as worktree from './worktree';
import { convCwd, inWorktree } from '../shared/conv';
import { createSdkMcpServer, tool, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as conda from './conda';
import { TeamManager } from './team';
import type { CondaInfo, ConversationMeta } from '../shared/types';
import { Store, samePath } from './store';
import { TerminalManager, listShells } from './terminal';

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
let terminals: TerminalManager;
let review: ReviewManager;
let team: TeamManager;

const emit = (ev: ConvEvent) => {
  win?.webContents.send(EVENT_CHANNEL, ev);
  review?.onConvEvent(ev); // 一轮结束时给“上一轮”拍结束快照
  team?.onConvEvent(ev); // 员工的一轮结束：任务完成，结果送回派活的主对话
};
const gitBash = () => detectGitBash(store.state.prefs.gitBashPath);
/** 撤销新文件：移到回收站，不直接删（自动化测试设 CLAUDEX_TRASH_DIR，移到那个目录，不碰系统回收站） */
const trash = async (p: string) => {
  const dir = process.env.CLAUDEX_TRASH_DIR;
  if (!dir) return shell.trashItem(p);
  fs.mkdirSync(dir, { recursive: true });
  fs.renameSync(p, path.join(dir, `${Date.now()}-${path.basename(p)}`));
};

// ---------------- 项目环境（conda） ----------------

/** 启动时查一次，之后在登记、切换环境时刷新（会话启动时要同步拿到） */
let condaState: (CondaInfo & { install: conda.CondaInstall | null }) | null = null;
const refreshConda = async (force = false) => (condaState = await conda.condaInfo(force));

/** 某个目录属于哪个项目（worktree 对话的目录也算它的项目） */
function projectOf(dir: string) {
  const conv = store.state.conversations.find(c => c.worktree && samePath(c.worktree.cwd, dir));
  if (conv) return store.project(conv.projectPath);
  const d = path.resolve(dir).toLowerCase();
  return store.state.projects.find(p => { const pp = path.resolve(p.path).toLowerCase(); return d === pp || d.startsWith(pp + path.sep); });
}

/** Claude Code 子进程的环境变量：项目指定了 conda 环境就像 conda activate 一样带上 */
function envFor(projectPath?: string): Record<string, string | undefined> {
  const env = sessionEnv(gitBash().path, app.getVersion());
  const p = projectPath ? store.project(projectPath) : undefined;
  return p?.condaEnv ? conda.activate(env, p.condaEnv, condaState?.install ?? null) : env;
}

/** 加在 Claude Code 默认系统提示后面的：项目环境的说明 + 团队（主对话是负责人，员工有自己的协作规矩） */
function systemAppend(meta: ConversationMeta): string | null {
  const p = store.project(meta.projectPath);
  const env = !condaState && !p?.condaEnv ? null
    : conda.envPrompt(p?.name ?? path.basename(meta.projectPath), p?.condaEnv, condaState ?? { available: true, root: null, envs: [] });
  const teamPart = meta.employee ? team.employeePrompt(meta) : team.bossPrompt(meta);
  return [env, teamPart].filter(Boolean).join('\n\n') || null;
}

/** Claudex 提供给 Claude 的工具：主对话有团队工具和登记项目环境；员工没有 */
function claudexMcp(meta: ConversationMeta): Record<string, McpServerConfig> | null {
  if (meta.employee) return null;
  const tools = [...team.bossTools(meta), ...(condaState?.available ? envTools(meta) : [])];
  return { claudex: createSdkMcpServer({ name: 'claudex', version: app.getVersion(), tools }) };
}

function envTools(meta: ConversationMeta) {
  return [
      tool(
        'set_project_env',
        '把一个 conda 环境登记为本项目的 Python 环境。登记以后，本项目所有的对话（包括 worktree 里的）和终端都会自动用它（放在 PATH 最前面）。参数是 conda env list 里的环境名，或者环境的完整路径。',
        { env: z.string().describe('conda 环境名（比如 myproj）或完整路径') },
        async ({ env }) => {
          const info = await refreshConda(true); // 可能刚新建了环境
          const hit = conda.findEnv(info, env);
          if (!hit) {
            const list = info.envs.map(e => `${e.name}（${e.prefix}）`).join('、') || '（没有）';
            return { content: [{ type: 'text', text: `找不到 conda 环境「${env}」。现有的环境：${list}。先用 conda create 建好再登记。` }], isError: true };
          }
          store.setProjectEnv(meta.projectPath, hit);
          manager.markProjectStale(meta.projectPath);
          emit({ kind: 'project-env', convId: meta.id, projectPath: meta.projectPath, env: hit });
          log(`项目环境：${meta.projectPath} → ${hit.prefix}（Claude 登记）`);
          return {
            content: [{
              type: 'text',
              text: `已登记：本项目的 Python 环境是 conda 环境「${hit.name}」（${hit.prefix}）。本项目所有对话（包括 worktree 里的）从下一条消息开始自动用它。这一轮里如果还要运行 Python，请直接用 "${path.join(hit.prefix, 'python.exe')}"。`
            }]
          };
        }
      )
  ];
}

/** Claudex 替用户往对话里发消息（派给员工的任务、员工交回的结果）：界面上也显示出来 */
async function sendInternal(convId: string, text: string): Promise<void> {
  const meta = store.conversation(convId);
  if (!meta) throw new Error('对话不存在');
  emit({ kind: 'injected', convId, text });
  await review.turnStart(convId, convCwd(meta));
  await manager.send(convId, text);
}

/** 删 worktree 之前：关掉这个对话的 Claude 进程和终端、停止监视（Windows 上有程序占着文件夹就删不掉） */
async function releaseWorktree(convId: string, dir: string): Promise<void> {
  review.suspend(dir); // 删除期间界面再要求监视它也不监视
  manager.delete(convId);
  terminals.closeKeys(k => k === convId);
  await review.watch(null);
  await new Promise(r => setTimeout(r, 300)); // 等进程退出
}

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
  const api: Omit<ClaudexApi, 'onEvent' | 'onTerm' | 'onGit' | 'termWrite' | 'termResize' | 'pathForFile'> = {
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
      const convIds = new Set(store.state.conversations.filter(c => samePath(c.projectPath, p)).map(c => c.id));
      for (const id of convIds) { manager.delete(id); review.forget(id); }
      terminals.closeKeys(k => convIds.has(k) || (k.startsWith('project:') && samePath(k.slice(8), p)));
      store.removeProject(p);
      return store.state;
    },
    newConversation: async (p, opts) => store.newConversation(p, opts?.worktree ? await worktree.createWorktree(p) : undefined),
    worktreeCheck: p => worktree.worktreeCheck(p),
    handoff: async id => {
      const meta = store.conversation(id);
      if (!meta?.worktree || !inWorktree(meta)) throw new Error('这个对话不在 worktree 里');
      if (manager.isBusy(id)) throw new Error('Claude 正在回复或者在等你审批，等这一轮结束再接手');
      await releaseWorktree(id, meta.worktree.path);
      let r: Awaited<ReturnType<typeof worktree.handoff>>;
      try {
        r = await worktree.handoff(meta.projectPath, meta.worktree);
      } finally {
        review.resume(meta.worktree.path);
      }
      if (r.leftover) log(`接手后 worktree 文件夹没删干净：${r.leftover}`);
      // 对话改在本地继续：会话 ID 不变（Claude Code 能跨同一仓库的 worktree 找到会话，见 spikes/c3）
      const next = { ...meta, worktree: { ...meta.worktree, handedOff: { at: Date.now(), files: r.files } } };
      store.updateConversation(next);
      const root = await git.repoRoot(meta.projectPath);
      if (root) review.moveConv(id, root);
      emit({ kind: 'meta', convId: id, meta: next });
      return { ...r, branch: meta.worktree.branch, meta: next };
    },
    openConversation: async id => ({ ...(await manager.open(id)), judged: team.judgedFor(id) }),
    deleteConversation: async id => {
      const meta = store.conversation(id);
      if (meta?.worktree && inWorktree(meta)) {
        // worktree 里的改动先存到它的分支上，再删掉 worktree
        await releaseWorktree(id, meta.worktree.path);
        try {
          const leftover = await worktree.discard(meta.projectPath, meta.worktree);
          if (leftover) log(`删除对话时 worktree 文件夹没删干净：${leftover}`);
        } finally {
          review.resume(meta.worktree.path);
        }
      }
      manager.delete(id);
      review.forget(id);
      team.forget(id);
      terminals.closeKeys(k => k === id);
      store.removeConversation(id);
      return store.state;
    },
    send: async (id, text, images, files) => {
      // 先给“上一轮”拍开始快照
      const meta = store.conversation(id);
      if (meta) await review.turnStart(id, convCwd(meta));
      team.onUserSend(id); // 用户直接在员工对话里发的消息，不算任务
      return manager.send(id, text, images, files);
    },
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
    openExternal: async url => { if (/^https?:/i.test(url)) await shell.openExternal(url); },
    listShells: async () => listShells(gitBash().path),
    termOpen: async (key, cwd, sh, size) => terminals.open(key, cwd, sh, size),
    termRestart: async (id, sh, size) => terminals.restart(id, sh, size),
    termKill: async id => terminals.close(id),
    termRekey: async (from, to) => terminals.rekey(from, to),
    // ---- Git 审查和提交（C2） ----
    gitStatus: cwd => git.status(cwd),
    gitDiff: (cwd, scope, convId) => (scope === 'turn' ? review.diff(convId, cwd) : git.scopeDiff(cwd, scope)),
    gitStage: (cwd, paths) => git.stage(cwd, paths),
    gitUnstage: (cwd, paths) => git.unstage(cwd, paths),
    gitRevert: async (cwd, scope, paths, convId) => {
      if (scope === 'turn') await review.revert(convId, paths, trash);
      else if (scope === 'unstaged') await git.revertUnstaged(cwd, paths, trash);
      else throw new Error('这个范围里不能撤销');
    },
    gitCommit: (cwd, req) => git.commit(cwd, req, root => writeCommitMessage(root, sessionEnv(gitBash().path, app.getVersion()))),
    gitInit: cwd => git.init(cwd),
    gitCheckBranch: (cwd, name) => git.checkBranchName(cwd, name),
    gitWatch: cwd => review.watch(cwd),
    // ---- 项目环境（conda） ----
    condaInfo: async force => {
      const { install: _install, ...info } = await refreshConda(!!force);
      return info;
    },
    setProjectEnv: async (p, prefix) => {
      if (prefix === null) store.setProjectEnv(p, null);
      else {
        const hit = conda.findEnv(await refreshConda(), prefix) ?? conda.findEnv(await refreshConda(true), prefix);
        if (!hit) throw new Error(`找不到这个 conda 环境：${prefix}`);
        store.setProjectEnv(p, hit);
      }
      manager.markProjectStale(p);
      return store.state;
    },
    // ---- 团队 ----
    listEmployees: async p => team.listProfiles(p),
    saveEmployee: async (p, profile, isNew) => { team.saveProfile(p, profile, isNew); return team.listProfiles(p); },
    deleteEmployee: async (p, id) => { team.deleteProfile(p, id); return team.listProfiles(p); },
    listTasks: async p => team.listTasks(p),
    newEmployeeConversation: async (p, id) => {
      const profile = team.findProfile(p, id);
      if (!profile) throw new Error(`找不到员工「${id}」`);
      return team.newEmployeeConversation(p, profile);
    }
  };
  for (const m of API_METHODS) {
    ipcMain.handle(channel(m), (_e, ...args: unknown[]) => (api[m] as (...a: unknown[]) => unknown)(...args));
  }
  // 终端输入和调整大小很频繁，不需要返回值，用 send
  ipcMain.on(channel('termWrite'), (_e, id: string, data: string) => terminals.write(id, data));
  ipcMain.on(channel('termResize'), (_e, id: string, cols: number, rows: number) => terminals.resize(id, cols, rows));
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
      env: meta => envFor(meta?.projectPath),
      systemAppend,
      extraMcp: claudexMcp,
      agentOptions: meta => team.agentOptions(meta),
      writeGuard: (meta, toolName, input) => team.writeGuard(meta, toolName, input),
      approve: (meta, request) => team.approve(meta, request),
      blacklist: () => store.state.prefs.blacklist,
      disabledMcp,
      emit,
      log
    });
    terminals = new TerminalManager(ev => win?.webContents.send(TERM_CHANNEL, ev), () => gitBash().path, log, cwd => {
      const p = projectOf(cwd); // 终端也用项目指定的 conda 环境
      return p?.condaEnv ? conda.activate({ ...process.env } as Record<string, string | undefined>, p.condaEnv, condaState?.install ?? null) : null;
    });
    void refreshConda().catch(e => log(`查 conda 失败：${e instanceof Error ? e.message : e}`));
    review = new ReviewManager(app.getPath('userData'), ev => win?.webContents.send(GIT_CHANNEL, ev), log);
    team = new TeamManager(app.getPath('userData'), { store, send: sendInternal, emit, env: p => envFor(p), isBusy: id => manager.isBusy(id), log });
    registerIpc();
    createWindow();
    log(`Claudex ${app.getVersion()} 启动；Git Bash：${gitBash().path ?? '没找到'}`);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    manager?.closeAll();
    terminals?.closeAll();
    review?.close();
    team?.saveNow();
    store?.saveNow();
  });
}
