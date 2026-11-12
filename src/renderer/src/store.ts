// 界面状态（zustand）：项目、对话、时间线、弹窗、草稿。所有和主进程的交互都从这里走。
import { create } from 'zustand';
import type {
  AppState, ConvEvent, ConvStatus, ConversationMeta, Effort, EnvInfo, ImageAttachment, McpServerInfo,
  ModeId, ModelOption, PermissionDecision, Prefs, ProjectCheck, UsageInfo
} from '@shared/types';
import { MODES } from './modes';
import { addApproval, addNotice, addUser, applySdk, emptyTimeline, resolveApproval, type Timeline } from './timeline';

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
  | null;

/** 还没发第一条消息的新对话：只记住项目和选好的模式、模型 */
export interface Draft {
  mode: ModeId;
  model: string;
  effort: Effort;
}

interface PendingSend {
  text: string;
  images: ImageAttachment[];
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
  send(text: string, images: ImageAttachment[]): Promise<void>;
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
}

let toastSeq = 0;

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

    async init() {
      const [app, env] = await Promise.all([api.getState(), api.getEnv()]);
      document.documentElement.dataset.theme = app.prefs.theme;
      api.onEvent(ev => get().onEvent(ev));
      const firstProject = app.projects[0]?.path ?? null;
      set({ app, env, ready: true, activeProject: firstProject, draft: firstProject ? { mode: app.prefs.defaultMode, model: app.prefs.defaultModel, effort: app.prefs.defaultEffort } : null });
      if (firstProject) void get().refreshBranch(firstProject);
      // 模型列表要起一个 Claude Code 进程去查，放后台
      api.listModels()
        .then(models => set({ models, modelsError: null }))
        .catch(e => set({ modelsError: e instanceof Error ? e.message : String(e) }));
    },

    onEvent(ev) {
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
      set({ activeId: null, activeProject: project, draft: project ? defaultDraft() : null });
      if (project) void get().refreshBranch(project);
    },

    async openConversation(id) {
      const existing = get().convs[id];
      if (!existing?.loaded) {
        const o = await api.openConversation(id);
        let timeline = o.history.reduce<Timeline>((t, m) => applySdk(t, m, false), emptyTimeline());
        for (const r of o.pending) timeline = addApproval(timeline, r);
        set(s => ({ convs: { ...s.convs, [id]: { meta: o.meta, status: o.status, timeline, usage: o.usage, loaded: true } } }));
      }
      const meta = get().convs[id].meta;
      set({ activeId: id, activeProject: meta.projectPath, draft: null });
      void get().refreshBranch(meta.projectPath);
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
      const app = await api.deleteConversation(id);
      const convs = { ...get().convs };
      const project = convs[id]?.meta.projectPath;
      delete convs[id];
      set({ app, convs });
      if (get().activeId === id) get().startDraft(project);
    },

    async send(text, images) {
      const s = get();
      const active = s.activeId ? s.convs[s.activeId] : null;
      const projectPath = active?.meta.projectPath ?? s.activeProject;
      if (!projectPath || (!text.trim() && !images.length)) return;
      // 进程还没起来时，先检查项目里有没有没批准过的 MCP 服务器（M0 发现 SDK 不会问）
      if (!active || active.status === 'new' || active.status === 'dormant' || active.status === 'error') {
        const servers = await api.pendingMcp(projectPath);
        if (servers.length) {
          set({ dialog: { kind: 'mcp', projectPath, servers }, pendingSend: { text, images } });
          return;
        }
      }
      let id = s.activeId;
      if (!id) {
        const draft = s.draft ?? defaultDraft();
        let meta = await api.newConversation(projectPath);
        // 草稿阶段开的终端跟着转到这个新对话
        await api.termRekey(`project:${projectPath}`, meta.id);
        if (draft.mode !== meta.mode) await api.setMode(meta.id, draft.mode);
        if (draft.model !== meta.model || draft.effort !== meta.effort) await api.setModel(meta.id, draft.model, draft.effort);
        meta = { ...meta, mode: draft.mode, model: draft.model, effort: draft.effort };
        id = meta.id;
        upsertMetaInApp(meta);
        set(st => ({ convs: { ...st.convs, [meta.id]: { meta, status: 'new', timeline: emptyTimeline(), loaded: true } }, activeId: meta.id, draft: null }));
      }
      const convId = id;
      patchConv(convId, c => ({ status: 'running', timeline: addUser(c.timeline, text, images.length, c.meta.mode === 'skills') }));
      set(st => ({ sentToken: st.sentToken + 1, pendingSend: null }));
      try {
        await api.send(convId, text, images);
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
      if (pending) await get().send(pending.text, pending.images);
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
      const branch = await api.gitBranch(projectPath);
      set(s => ({ branches: { ...s.branches, [projectPath]: branch } }));
    }
  };
});

/** 当前对话（或草稿）用的模式、模型 */
export function useCurrentSettings(): Draft | null {
  return useStore(s => (s.activeId ? s.convs[s.activeId]?.meta ?? null : s.draft));
}
