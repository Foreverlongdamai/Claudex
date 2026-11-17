// 界面状态（zustand）：项目、对话、时间线、弹窗、草稿。所有和主进程的交互都从这里走。
import { create } from 'zustand';
import type {
  Automation, AutomationRun, AutomationState, AppState, CommandInfo, CommitRequest, CommitResult, CondaInfo, ConvEvent, EmployeeProfile, TeamTask, ConvStatus, ConversationMeta, Effort, EnvInfo, FileAttachment, GitEvent,
  GitScope, GitStatus, ImageAttachment, McpServerInfo, ModeId, ModelOption, PermissionDecision, Prefs, ProjectCheck, UsageInfo
} from '@shared/types';
import { convCwd } from '@shared/conv';
import { MODES } from './modes';
import { addApproval, addInjected, addNotice, addUser, applySdk, emptyTimeline, resolveApproval, type Timeline } from './timeline';

const api = window.claudex;

export interface ConvView {
  meta: ConversationMeta;
  status: ConvStatus;
  error?: string;
  timeline: Timeline;
  usage?: UsageInfo;
  loaded: boolean;
}

export type Dialog =
  | { kind: 'bypass'; convId: string | null }
  | { kind: 'mcp'; projectPath: string; servers: McpServerInfo[] }
  | { kind: 'trust'; check: ProjectCheck }
  | { kind: 'settings' }
  | { kind: 'pr-branch'; cwd: string; message: string }
  | { kind: 'handoff'; convId: string }
  /** 新建或修改员工档案；profile 为 null 是招新员工 */
  | { kind: 'employee'; projectPath: string; profile: EmployeeProfile | null }
  | { kind: 'automation'; automation: Automation | null }
  | { kind: 'rename'; convId: string; title: string }
  | null;

const STEP_LABEL: Record<NonNullable<CommitResult['error']>['step'], string> = {
  message: 'Claude 写提交说明', branch: '新建分支', commit: '提交', push: '推送', pr: '开 PR'
};
const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));

/** 还没发第一条消息的新对话：只记住项目和选好的模式、模型 */
export interface Draft {
  mode: ModeId;
  model: string;
  effort: Effort;
  /** 在本地项目文件夹里干活，还是开一个新的 worktree（C3，默认本地） */
  place?: 'local' | 'worktree';
}

interface PendingSend {
  text: string;
  images: ImageAttachment[];
  files: FileAttachment[];
}

interface UiState {
  ready: boolean;
  app: AppState | null;
  env: EnvInfo | null;
  models: ModelOption[];
  modelsError: string | null;
  convs: Record<string, ConvView>;
  activeId: string | null;
  activeProject: string | null;
  draft: Draft | null;
  branches: Record<string, string | null>;
  dialog: Dialog;
  toasts: { id: number; text: string }[];
  /** 每次真正发出消息就加 1，输入框看到变化就清空 */
  sentToken: number;
  pendingSend: PendingSend | null;
  /** 内置终端面板是否打开 */
  terminalOpen: boolean;
  // ---- 改动面板（C2） ----
  reviewOpen: boolean;
  reviewScope: GitScope;
  /** 项目路径 → git 状态（顶栏的改动统计、提交框用） */
  git: Record<string, GitStatus>;
  /** 文件有变化、一轮结束、做完 git 操作时加 1，改动面板看到变化就重新读 diff */
  gitTick: number;
  /** 提交成功时加 1，提交框看到变化就清空 */
  commitToken: number;
  /** 正在提交、推送……（显示在提交按钮上） */
  gitBusy: string | null;

  init(): Promise<void>;
  onEvent(ev: ConvEvent): void;
  toast(text: string): void;
  closeDialog(): void;
  startDraft(projectPath?: string): void;
  openConversation(id: string): Promise<void>;
  pickProject(): Promise<void>;
  confirmTrust(): Promise<void>;
  removeProject(path: string): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  send(text: string, images: ImageAttachment[], files?: FileAttachment[]): Promise<void>;
  finishMcpGate(decisions: Record<string, boolean>): Promise<void>;
  interrupt(): Promise<void>;
  requestMode(mode: ModeId): void;
  applyMode(convId: string | null, mode: ModeId, skipConfirmNextTime?: boolean): Promise<void>;
  setModel(model: string, effort: Effort): Promise<void>;
  respond(convId: string, decision: PermissionDecision, note?: string): Promise<void>;
  setTheme(theme: 'dark' | 'light'): Promise<void>;
  setPrefs(patch: Partial<Prefs>): Promise<void>;
  refreshBranch(projectPath: string): Promise<void>;
  toggleTerminal(open?: boolean): void;
  onGit(ev: GitEvent): void;
  toggleReview(open?: boolean): void;
  setReviewScope(scope: GitScope): void;
  /** 暂存、取消暂存、撤销；出错时提示 */
  gitAction(kind: 'stage' | 'unstage' | 'revert', cwd: string, paths: string[], scope?: GitScope): Promise<boolean>;
  gitInit(cwd: string): Promise<void>;
  commit(cwd: string, req: CommitRequest): Promise<CommitResult>;
  /** 当前对话（或草稿）的项目里加一条提示 */
  notify(tone: 'ok' | 'error', text: string, detail?: string, link?: { label: string; url: string }): void;
  setDraftPlace(place: 'local' | 'worktree'): void;
  // ---- 团队 ----
  /** 项目路径 → 员工档案 */
  team: Record<string, EmployeeProfile[]>;
  /** 任务编号 → 任务 */
  tasks: Record<string, TeamTask>;
  loadTeam(projectPath: string): Promise<void>;
  /** 打开员工：他最近的对话，没有就新开一个 */
  openEmployee(projectPath: string, employeeId: string): Promise<void>;
  /** 和员工新开一个对话 */
  newEmployeeChat(projectPath: string, employeeId: string): Promise<void>;
  saveEmployee(projectPath: string, profile: EmployeeProfile, isNew: boolean): Promise<boolean>;
  deleteEmployee(projectPath: string, id: string): Promise<void>;
  /** 主区域显示对话、任务看板，还是自动化 */
  view: View;
  setView(view: View): void;
  /** 项目路径 → 能用的 Skills（全局、项目、插件） */
  skills: Record<string, CommandInfo[]>;
  loadSkills(projectPath: string): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  /** 本机的 conda（没装就是 available: false） */
  conda: CondaInfo | null;
  loadConda(force?: boolean): Promise<void>;
  setProjectEnv(projectPath: string, prefix: string | null): Promise<void>;
  /** 接手到本地（C3） */
  handoff(convId: string): Promise<void>;
  // ---- 自动化（C4） ----
  automation: AutomationState | null;
  loadAutomations(): Promise<void>;
  /** 保存（runNow 时保存后马上跑一次）；出错返回原因 */
  saveAutomation(a: Parameters<typeof api.saveAutomation>[0], runNow: boolean): Promise<string | null>;
  deleteAutomation(id: string): Promise<void>;
  setAutomationEnabled(id: string, enabled: boolean): Promise<void>;
  runAutomation(id: string): Promise<void>;
  markRunRead(runId: string): Promise<void>;
  /** 打开这次运行的对话（跑完的顺便标为已读） */
  openRun(r: AutomationRun): Promise<void>;
  deleteRun(runId: string): Promise<void>;
  // ---- 对话历史（M2） ----
  /** 打开一个会话（命令行的会话先加进 Claudex） */
  openSession(sessionId: string, projectPath: string): Promise<void>;
  forkConversation(convId: string): Promise<void>;
  renameConversation(convId: string, title: string): Promise<string | null>;
  pinConversation(convId: string, pinned: boolean): Promise<void>;
  exportConversation(convId: string, format: 'md' | 'html'): Promise<void>;
}

export type View = 'chat' | 'board' | 'automation' | 'search';

let toastSeq = 0;
/**
 * 切换对话的顺序号：打开对话要先读历史（异步），读完时如果用户已经去了别处（新对话、别的对话），就不再切回去。
 * （端到端测试遇到过：一次慢的“打开”晚到，把用户已经切走的界面又拽回了别的对话）
 */
let navSeq = 0;
const navLog = (what: string) => console.debug(`[claudex-nav] ${what} ← ${(new Error().stack ?? '').split('\n').slice(2, 7).map(l => l.trim()).join(' | ')}`);

export const useStore = create<UiState>((set, get) => {
  /** 改某个对话的视图 */
  const patchConv = (id: string, fn: (c: ConvView) => Partial<ConvView>) =>
    set(s => (s.convs[id] ? { convs: { ...s.convs, [id]: { ...s.convs[id], ...fn(s.convs[id]) } } } : s));

  const upsertMetaInApp = (meta: ConversationMeta) =>
    set(s => {
      if (!s.app) return s;
      const list = s.app.conversations.some(c => c.id === meta.id)
        ? s.app.conversations.map(c => (c.id === meta.id ? meta : c))
        : [...s.app.conversations, meta];
      return { app: { ...s.app, conversations: list } };
    });

  const defaultDraft = (): Draft => {
    const p = get().app!.prefs;
    return { mode: p.defaultMode, model: p.defaultModel, effort: p.defaultEffort };
  };

  return {
    ready: false,
    app: null,
    env: null,
    models: [],
    modelsError: null,
    convs: {},
    activeId: null,
    activeProject: null,
    draft: null,
    branches: {},
    dialog: null,
    toasts: [],
    sentToken: 0,
    pendingSend: null,
    terminalOpen: false,
    reviewOpen: false,
    reviewScope: 'unstaged',
    git: {},
    gitTick: 0,
    commitToken: 0,
    gitBusy: null,
    conda: null,
    team: {},
    tasks: {},
    view: 'chat',
    skills: {},
    automation: null,

    async init() {
      const [app, env] = await Promise.all([api.getState(), api.getEnv()]);
      document.documentElement.dataset.theme = app.prefs.theme;
      api.onEvent(ev => get().onEvent(ev));
      api.onGit(ev => get().onGit(ev));
      const firstProject = app.projects[0]?.path ?? null;
      set({ app, env, ready: true, activeProject: firstProject, draft: firstProject ? { mode: app.prefs.defaultMode, model: app.prefs.defaultModel, effort: app.prefs.defaultEffort } : null });
      if (firstProject) void get().refreshBranch(firstProject);
      void get().loadConda();
      for (const p of app.projects) void get().loadTeam(p.path);
      void get().loadAutomations();
      // 模型列表要起一个 Claude Code 进程去查，放后台
      api.listModels()
        .then(models => set({ models, modelsError: null }))
        .catch(e => set({ modelsError: e instanceof Error ? e.message : String(e) }));
    },

    onEvent(ev) {
      if (ev.kind === 'automation') {
        set({ automation: ev.state });
        return;
      }
      if (ev.kind === 'navigate') {
        if (ev.to === 'automation') set({ view: 'automation', dialog: null });
        else void get().openConversation(ev.convId);
        return;
      }
      if (ev.kind === 'task') {
        set(s => ({ tasks: { ...s.tasks, [ev.task.id]: ev.task } }));
        return;
      }
      if (ev.kind === 'team') {
        void get().loadTeam(ev.projectPath);
        return;
      }
      if (ev.kind === 'meta') {
        upsertMetaInApp(ev.meta);
        patchConv(ev.convId, () => ({ meta: ev.meta }));
        return;
      }
      const cv = get().convs[ev.convId];
      if (!cv) return;
      switch (ev.kind) {
        case 'sdk':
          patchConv(ev.convId, c => ({ timeline: applySdk(c.timeline, ev.msg, true) }));
          break;
        case 'status':
          patchConv(ev.convId, c => ({
            status: ev.status,
            error: ev.error,
            timeline: ev.status === 'error' ? addNotice(c.timeline, 'error', 'Claude Code 进程出错了，再发一条消息会自动重新连接', ev.error) : c.timeline
          }));
          break;
        case 'permission':
          patchConv(ev.convId, c => ({ timeline: addApproval(c.timeline, ev.request) }));
          break;
        case 'permission-cancel':
          patchConv(ev.convId, c => ({ timeline: resolveApproval(c.timeline, ev.requestId, 'cancelled') }));
          break;
        case 'usage':
          patchConv(ev.convId, () => ({ usage: ev.usage }));
          break;
        case 'blocked':
          patchConv(ev.convId, c => ({ timeline: addNotice(c.timeline, 'blocked', `保底黑名单拦截了一条命令：${ev.rule}`, ev.detail) }));
          break;
        case 'mode':
          patchConv(ev.convId, c => ({ meta: { ...c.meta, mode: ev.mode } }));
          get().toast(MODES[ev.mode].toast);
          break;
        case 'injected':
          patchConv(ev.convId, c => ({ timeline: addInjected(c.timeline, ev.text) }));
          break;
        case 'notice':
          patchConv(ev.convId, c => ({ timeline: addNotice(c.timeline, ev.tone, ev.text, ev.detail) }));
          break;
        case 'project-env':
          set(s => (s.app ? { app: { ...s.app, projects: s.app.projects.map(p => (p.path === ev.projectPath ? { ...p, condaEnv: ev.env } : p)) } } : s));
          patchConv(ev.convId, c => ({
            timeline: addNotice(c.timeline, 'ok', `Claude 把 conda 环境「${ev.env.name}」登记为这个项目的 Python 环境`, `${ev.env.prefix}\n这个项目里所有的对话（包括 worktree 里的）和终端都会用它；可以在输入框下面更换`)
          }));
          break;
      }
    },

    toast(text) {
      const id = ++toastSeq;
      set(s => ({ toasts: [...s.toasts, { id, text }] }));
      setTimeout(() => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })), 3200);
    },

    closeDialog() {
      set({ dialog: null, pendingSend: null });
    },

    startDraft(projectPath) {
      const project = projectPath ?? get().activeProject ?? get().app?.projects[0]?.path ?? null;
      navSeq++;
      navLog(`draft ${project}`);
      set({ activeId: null, activeProject: project, draft: project ? defaultDraft() : null, view: 'chat' });
      if (project) void get().refreshBranch(project);
    },

    async openConversation(id) {
      const my = ++navSeq;
      const existing = get().convs[id];
      if (!existing?.loaded) {
        const o = await api.openConversation(id);
        let timeline = o.history.reduce<Timeline>((t, m) => applySdk(t, m, false), emptyTimeline());
        for (const r of o.pending) timeline = addApproval(timeline, r);
        set(s => ({ convs: { ...s.convs, [id]: { meta: o.meta, status: o.status, timeline, usage: o.usage, loaded: true } } }));
      }
      if (my !== navSeq) { navLog(`open ${id} 晚到了，用户已经去了别处，不切过去`); return; }
      navLog(`open ${id}`);
      const meta = get().convs[id].meta;
      set({ activeId: id, activeProject: meta.projectPath, draft: null, view: 'chat' });
      void get().refreshBranch(convCwd(meta));
    },

    async pickProject() {
      const check = await api.pickProject();
      if (!check) return;
      // 项目自带 hooks 或 MCP 服务器时先让用户确认信任
      if (check.hooks > 0 || check.mcpServers.length > 0) set({ dialog: { kind: 'trust', check } });
      else {
        set({ dialog: { kind: 'trust', check } });
        await get().confirmTrust();
      }
    },

    async confirmTrust() {
      const d = get().dialog;
      if (d?.kind !== 'trust') return;
      const app = await api.addProject(d.check.path);
      set({ app, dialog: null });
      void get().loadTeam(d.check.path);
      get().startDraft(d.check.path);
      get().toast(`已添加项目 ${d.check.name}`);
    },

    async removeProject(path) {
      const app = await api.removeProject(path);
      const convs = { ...get().convs };
      for (const id of Object.keys(convs)) if (convs[id].meta.projectPath === path) delete convs[id];
      set({ app, convs, activeId: null });
      get().startDraft(app.projects[0]?.path);
    },

    async deleteConversation(id) {
      let app: AppState;
      try {
        app = await api.deleteConversation(id);
      } catch (e) {
        get().toast(`删除失败：${errText(e)}`);
        return;
      }
      const convs = { ...get().convs };
      const project = convs[id]?.meta.projectPath;
      delete convs[id];
      set({ app, convs });
      if (get().activeId === id) get().startDraft(project);
    },

    async send(text, images, files = []) {
      const s = get();
      const active = s.activeId ? s.convs[s.activeId] : null;
      const projectPath = active?.meta.projectPath ?? s.activeProject;
      if (!projectPath || (!text.trim() && !images.length && !files.length)) return;
      // 进程还没起来时，先检查项目里有没有没批准过的 MCP 服务器（M0 发现 SDK 不会问）
      if (!active || active.status === 'new' || active.status === 'dormant' || active.status === 'error') {
        const servers = await api.pendingMcp(projectPath);
        if (servers.length) {
          set({ dialog: { kind: 'mcp', projectPath, servers }, pendingSend: { text, images, files } });
          return;
        }
      }
      let id = s.activeId;
      if (!id) {
        const draft = s.draft ?? defaultDraft();
        const inWt = draft.place === 'worktree';
        let meta: ConversationMeta;
        try {
          if (inWt) get().toast('正在创建 worktree…');
          meta = await api.newConversation(projectPath, { worktree: inWt });
        } catch (e) {
          get().toast(`${inWt ? '创建 worktree 失败' : '新建对话失败'}：${errText(e)}`);
          return;
        }
        // 草稿阶段开的终端跟着转到这个新对话（worktree 对话的目录不一样，不转）
        if (!inWt) await api.termRekey(`project:${projectPath}`, meta.id);
        else void get().refreshBranch(convCwd(meta));
        if (draft.mode !== meta.mode) await api.setMode(meta.id, draft.mode);
        if (draft.model !== meta.model || draft.effort !== meta.effort) await api.setModel(meta.id, draft.model, draft.effort);
        meta = { ...meta, mode: draft.mode, model: draft.model, effort: draft.effort };
        id = meta.id;
        upsertMetaInApp(meta);
        navSeq++;
        navLog(`new ${meta.id}`);
        set(st => ({ convs: { ...st.convs, [meta.id]: { meta, status: 'new', timeline: emptyTimeline(), loaded: true } }, activeId: meta.id, draft: null }));
      }
      const convId = id;
      patchConv(convId, c => ({ status: 'running', timeline: addUser(c.timeline, text, images.length, c.meta.mode === 'skills', files.map(f => f.path)) }));
      set(st => ({ sentToken: st.sentToken + 1, pendingSend: null }));
      try {
        await api.send(convId, text, images, files);
      } catch (e) {
        patchConv(convId, c => ({ status: 'error', timeline: addNotice(c.timeline, 'error', '消息没有发出去', e instanceof Error ? e.message : String(e)) }));
      }
    },

    async finishMcpGate(decisions) {
      const d = get().dialog;
      if (d?.kind !== 'mcp') return;
      for (const [name, approved] of Object.entries(decisions)) await api.setMcpApproval(d.projectPath, name, approved);
      const pending = get().pendingSend;
      set({ dialog: null });
      if (pending) await get().send(pending.text, pending.images, pending.files);
    },

    async interrupt() {
      const id = get().activeId;
      if (id) await api.interrupt(id);
    },

    requestMode(mode) {
      const s = get();
      if (mode === 'bypassPermissions' && !s.app?.prefs.skipBypassConfirm) {
        set({ dialog: { kind: 'bypass', convId: s.activeId } });
        return;
      }
      void get().applyMode(s.activeId, mode);
    },

    async applyMode(convId, mode, skipConfirmNextTime) {
      if (skipConfirmNextTime) await get().setPrefs({ skipBypassConfirm: true });
      set({ dialog: null });
      if (convId) {
        patchConv(convId, c => ({ meta: { ...c.meta, mode } }));
        await api.setMode(convId, mode);
      } else {
        set(s => ({ draft: { ...(s.draft ?? defaultDraft()), mode } }));
      }
      get().toast(MODES[mode].toast);
    },

    async setModel(model, effort) {
      const id = get().activeId;
      if (id) {
        patchConv(id, c => ({ meta: { ...c.meta, model, effort } }));
        await api.setModel(id, model, effort);
      } else {
        set(s => ({ draft: { ...(s.draft ?? defaultDraft()), model, effort } }));
      }
    },

    async respond(convId, decision, note) {
      patchConv(convId, c => ({ timeline: resolveApproval(c.timeline, decision.requestId, decision.behavior, note) }));
      await api.respondPermission(convId, decision);
    },

    async setTheme(theme) {
      document.documentElement.dataset.theme = theme;
      set(s => (s.app ? { app: { ...s.app, prefs: { ...s.app.prefs, theme } } } : s));
      await api.setTheme(theme);
    },

    async setPrefs(patch) {
      const app = await api.setPrefs(patch);
      set({ app });
      if (patch.gitBashPath !== undefined) set({ env: await api.getEnv() });
    },

    toggleTerminal(open) {
      set(s => ({ terminalOpen: open ?? !s.terminalOpen }));
    },

    async refreshBranch(projectPath) {
      // 顺便监视这个项目的文件变化（主进程同时只监视一个，换项目时自动换）
      void api.gitWatch(projectPath).catch(() => {});
      const [branch, st] = await Promise.all([api.gitBranch(projectPath), api.gitStatus(projectPath).catch(() => null)]);
      set(s => ({ branches: { ...s.branches, [projectPath]: branch }, git: st ? { ...s.git, [projectPath]: st } : s.git }));
    },

    onGit(ev) {
      const s = get();
      const active = s.activeId ? s.convs[s.activeId]?.meta : null;
      const cwd = active ? convCwd(active) : s.activeProject;
      if (ev.kind === 'dirty') {
        if (cwd) void get().refreshBranch(cwd);
        set(st => ({ gitTick: st.gitTick + 1 }));
      } else if (ev.kind === 'turn' && ev.convId === s.activeId) {
        set(st => ({ gitTick: st.gitTick + 1 }));
      }
    },

    toggleReview(open) {
      set(s => ({ reviewOpen: open ?? !s.reviewOpen }));
    },

    setReviewScope(scope) {
      set({ reviewScope: scope });
    },

    async gitAction(kind, cwd, paths, scope) {
      const convId = get().activeId;
      try {
        if (kind === 'stage') await api.gitStage(cwd, paths);
        else if (kind === 'unstage') await api.gitUnstage(cwd, paths);
        else await api.gitRevert(cwd, scope ?? 'unstaged', paths, convId);
        return true;
      } catch (e) {
        get().toast(`${kind === 'stage' ? '暂存' : kind === 'unstage' ? '取消暂存' : '撤销'}失败：${errText(e)}`);
        return false;
      } finally {
        await get().refreshBranch(cwd);
        set(s => ({ gitTick: s.gitTick + 1 }));
      }
    },

    async gitInit(cwd) {
      try {
        await api.gitInit(cwd);
        get().toast('已初始化 Git 仓库');
      } catch (e) {
        get().toast(`初始化失败：${errText(e)}`);
      }
      await get().refreshBranch(cwd);
      set(s => ({ gitTick: s.gitTick + 1 }));
    },

    setView(view) {
      set({ view });
    },

    async loadSkills(projectPath) {
      if (get().skills[projectPath]) return;
      try {
        const list = await api.listSkills(projectPath);
        set(s => ({ skills: { ...s.skills, [projectPath]: list } }));
      } catch {
        set(s => ({ skills: { ...s.skills, [projectPath]: [] } }));
      }
    },

    async stopTask(taskId) {
      try {
        await api.stopTask(taskId);
        get().toast(`已停止任务 #${taskId}`);
      } catch (e) {
        get().toast(`停不下来：${errText(e)}`);
      }
    },

    async openSession(sessionId, projectPath) {
      try {
        const meta = await api.openSession(sessionId, projectPath);
        upsertMetaInApp(meta);
        await get().openConversation(meta.id);
      } catch (e) {
        get().toast(`打不开：${errText(e)}`);
      }
    },

    async forkConversation(convId) {
      try {
        const meta = await api.forkConversation(convId);
        upsertMetaInApp(meta);
        await get().openConversation(meta.id);
        get().toast('已分叉：这是一份副本，原来的对话不动');
      } catch (e) {
        get().toast(`分叉失败：${errText(e)}`);
      }
    },

    async renameConversation(convId, title) {
      try {
        const meta = await api.renameConversation(convId, title);
        upsertMetaInApp(meta);
        patchConv(convId, () => ({ meta }));
        set({ dialog: null });
        return null;
      } catch (e) {
        return errText(e);
      }
    },

    async pinConversation(convId, pinned) {
      const meta = await api.pinConversation(convId, pinned);
      upsertMetaInApp(meta);
      patchConv(convId, () => ({ meta }));
      get().toast(pinned ? '已置顶' : '已取消置顶');
    },

    async exportConversation(convId, format) {
      try {
        const file = await api.exportConversation(convId, format);
        if (file) get().notify('ok', `已导出：${file}`);
      } catch (e) {
        get().toast(`导出失败：${errText(e)}`);
      }
    },

    async loadAutomations() {
      try {
        set({ automation: await api.listAutomations() });
      } catch (e) {
        get().toast(`读取自动化失败：${errText(e)}`);
      }
    },

    async saveAutomation(a, runNow) {
      try {
        const st = await api.saveAutomation(a);
        set({ automation: st, dialog: null });
        const saved = a.id ? st.automations.find(x => x.id === a.id) : st.automations[st.automations.length - 1];
        get().toast(a.id ? `已保存「${a.name}」` : `已新建自动化「${a.name}」`);
        if (runNow && saved) await get().runAutomation(saved.id);
        return null;
      } catch (e) {
        return errText(e);
      }
    },

    async deleteAutomation(id) {
      set({ automation: await api.deleteAutomation(id) });
    },

    async setAutomationEnabled(id, enabled) {
      try {
        set({ automation: await api.setAutomationEnabled(id, enabled) });
      } catch (e) {
        get().toast(errText(e));
      }
    },

    async runAutomation(id) {
      try {
        await api.runAutomation(id);
        get().toast('开始运行，跑完会出现在审查队列里');
      } catch (e) {
        get().toast(`没有跑起来：${errText(e)}`);
      }
    },

    async markRunRead(runId) {
      set({ automation: await api.markRunRead(runId) });
    },

    async openRun(r) {
      if (!r.convId) return;
      await get().openConversation(r.convId);
      if (r.status === 'done' || r.status === 'failed') await get().markRunRead(r.id);
    },

    async deleteRun(runId) {
      try {
        set({ automation: await api.deleteRun(runId) });
      } catch (e) {
        get().toast(`删除失败：${errText(e)}`);
      }
    },

    async loadTeam(projectPath) {
      try {
        const [profiles, tasks] = await Promise.all([api.listEmployees(projectPath), api.listTasks(projectPath)]);
        set(s => ({ team: { ...s.team, [projectPath]: profiles }, tasks: { ...s.tasks, ...Object.fromEntries(tasks.map(t => [t.id, t])) } }));
      } catch {
        // 项目文件夹不在了之类，不影响别的
      }
    },

    async openEmployee(projectPath, employeeId) {
      const convs = get().app?.conversations.filter(c => c.projectPath === projectPath && c.employee?.id === employeeId) ?? [];
      const latest = convs.sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (latest) await get().openConversation(latest.id);
      else await get().newEmployeeChat(projectPath, employeeId);
    },

    async newEmployeeChat(projectPath, employeeId) {
      try {
        const meta = await api.newEmployeeConversation(projectPath, employeeId);
        upsertMetaInApp(meta);
        set(s => ({ convs: { ...s.convs, [meta.id]: { meta, status: 'new', timeline: emptyTimeline(), loaded: true } } }));
        await get().openConversation(meta.id);
      } catch (e) {
        get().toast(`打不开：${errText(e)}`);
      }
    },

    async saveEmployee(projectPath, profile, isNew) {
      try {
        const list = await api.saveEmployee(projectPath, profile, isNew);
        set(s => ({ team: { ...s.team, [projectPath]: list } }));
        get().toast(isNew ? `已招聘「${profile.displayName}」` : `已保存「${profile.displayName}」的档案`);
        return true;
      } catch (e) {
        get().toast(`保存失败：${errText(e)}`);
        return false;
      }
    },

    async deleteEmployee(projectPath, id) {
      try {
        const list = await api.deleteEmployee(projectPath, id);
        set(s => ({ team: { ...s.team, [projectPath]: list }, dialog: null }));
        get().toast('已删除档案（他的对话和长期记忆还在）');
      } catch (e) {
        get().toast(`删除失败：${errText(e)}`);
      }
    },

    async loadConda(force) {
      try {
        set({ conda: await api.condaInfo(force) });
      } catch {
        set({ conda: { available: false, root: null, envs: [] } });
      }
    },

    async setProjectEnv(projectPath, prefix) {
      try {
        const app = await api.setProjectEnv(projectPath, prefix);
        set({ app });
        const env = app.projects.find(p => p.path === projectPath)?.condaEnv;
        get().toast(env ? `这个项目改用 conda 环境「${env.name}」（正在运行的对话下一条消息起生效）` : '这个项目不指定 Python 环境了，需要时让 Claude 来选');
      } catch (e) {
        get().toast(`设置失败：${errText(e)}`);
      }
    },

    setDraftPlace(place) {
      set(s => ({ draft: { ...(s.draft ?? defaultDraft()), place } }));
    },

    async handoff(convId) {
      set({ dialog: null, gitBusy: '正在接手到本地…' });
      try {
        const r = await api.handoff(convId);
        upsertMetaInApp(r.meta);
        patchConv(convId, c => ({ meta: r.meta, status: c.status === 'error' ? 'dormant' : c.status }));
        const text = r.files ? `已接手到本地：${r.files} 个文件的改动搬到了项目文件夹，没有提交` : '已接手到本地（worktree 里没有改动）';
        get().notify('ok', text, `worktree 已删除；分支 ${r.branch} 里存着接手时的全部改动。之后这个对话就在本地项目文件夹里继续。`);
        if (r.conflicts.length) get().notify('error', `${r.conflicts.length} 个文件和本地的改动冲突了，已经写上冲突标记，请解决`, r.conflicts.join('\n'));
        if (r.leftover) get().notify('error', 'worktree 文件夹没删干净（可能还有程序在用它），改动已经搬到本地、也存在分支上了，可以稍后手动删掉这个文件夹', r.leftover);
        get().toast(r.conflicts.length ? `已接手，但有 ${r.conflicts.length} 个文件冲突` : '已接手到本地');
        // 打开改动面板看搬过来的改动
        set({ reviewOpen: true, reviewScope: 'unstaged' });
        await get().refreshBranch(r.meta.projectPath);
      } catch (e) {
        get().notify('error', '接手到本地失败', errText(e));
        get().toast(`接手失败：${errText(e).split('\n')[0]}`);
      } finally {
        set(s => ({ gitBusy: null, gitTick: s.gitTick + 1 }));
      }
    },

    notify(tone, text, detail, link) {
      const id = get().activeId;
      if (id) patchConv(id, c => ({ timeline: addNotice(c.timeline, tone, text, detail, link) }));
    },

    async commit(cwd, req) {
      const changes = (get().git[cwd]?.files.length ?? 0) > 0;
      set({
        gitBusy: changes && !req.message.trim() ? 'Claude 正在写提交说明…'
          : req.kind === 'pr' ? '正在开 PR…' : req.kind === 'push' ? (changes ? '正在提交并推送…' : '正在推送…') : '正在提交…'
      });
      let r: CommitResult;
      try {
        r = await api.gitCommit(cwd, req);
      } catch (e) {
        r = { branch: null, error: { step: 'commit', message: errText(e) } };
      }
      set({ gitBusy: null });
      const done = r.prUrl ? '已开 PR' : r.pushed ? (r.commit ? '已提交并推送' : '已推送') : r.commit ? '已提交' : null;
      if (done) {
        const text = `${done}${r.commit ? `：${r.commit.subject}` : r.pushed ? `到 ${r.pushed}` : ''}`;
        const detail = [
          r.commit && `${r.commit.hash} · ${r.commit.files} 个文件 · 分支 ${r.branch}${r.commit.generated ? ' · 提交说明是 Claude 写的' : ''}`,
          r.commit && r.pushed && `推送到 ${r.pushed}`,
          r.prUrl
        ].filter(Boolean).join('\n');
        get().notify('ok', text, detail || undefined, r.prUrl ? { label: '在浏览器里打开 PR', url: r.prUrl } : undefined);
        get().toast(text);
      }
      if (r.error) {
        get().notify('error', `${STEP_LABEL[r.error.step]}失败`, r.error.message);
        get().toast(`${STEP_LABEL[r.error.step]}失败：${r.error.message.split('\n')[0]}`);
      }
      if (r.commit) set(s => ({ commitToken: s.commitToken + 1 }));
      await get().refreshBranch(cwd);
      set(s => ({ gitTick: s.gitTick + 1 }));
      return r;
    }
  };
});

/** 当前对话（或草稿）实际的工作目录：worktree 对话是它的 worktree，否则是项目文件夹 */
export function useActiveCwd(): string | null {
  return useStore(s => {
    const meta = s.activeId ? s.convs[s.activeId]?.meta : null;
    return (meta ? convCwd(meta) : s.activeProject) ?? null;
  });
}

/** 当前对话（或草稿）用的模式、模型 */
export function useCurrentSettings(): Draft | null {
  return useStore(s => (s.activeId ? s.convs[s.activeId]?.meta ?? null : s.draft));
}
