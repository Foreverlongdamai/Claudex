// App 自己的数据：项目列表、对话列表、偏好设置、MCP 批准记录。
// 存在 userData/claudex-state.json。对话内容本身不存这里，由 Claude Code 自己的会话记录保存。
import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EFFORTS, type AppState, type ConversationMeta, type Effort, type Prefs, type Project } from '../shared/types';
import { DEFAULT_BLACKLIST } from './guard/blacklist';

const MODEL_IDS: Record<string, string> = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' };

function readClaudeUserSettings(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

const isEffort = (v: unknown): v is Effort => typeof v === 'string' && (EFFORTS as string[]).includes(v);

/** 默认值尽量跟用户在命令行里的习惯一致：模型、思考强度、主题 */
function defaultPrefs(): Prefs {
  const s = readClaudeUserSettings();
  const model = typeof s.model === 'string' && s.model ? s.model : 'opus';
  const perModel = s.modelSettings?.[MODEL_IDS[model] ?? model]?.effortLevel;
  const effort: Effort = isEffort(perModel) ? perModel : isEffort(s.effortLevel) ? s.effortLevel : 'high';
  return {
    defaultMode: 'default', // 新对话一律从“默认：询问”开始（用户确认过），不跟命令行的 bypass
    defaultModel: model,
    defaultEffort: effort,
    gitBashPath: null,
    maxLiveSessions: 4,
    theme: s.theme === 'light' ? 'light' : 'dark',
    skipBypassConfirm: false,
    blacklist: DEFAULT_BLACKLIST,
    terminalShell: 'powershell'
  };
}

export class Store {
  state: AppState;
  private file: string;
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    this.file = path.join(app.getPath('userData'), 'claudex-state.json');
    const defaults: AppState = { projects: [], conversations: [], prefs: defaultPrefs(), mcpApprovals: {} };
    let saved: Partial<AppState> = {};
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // 第一次启动，或者文件坏了：用默认值
    }
    this.state = {
      projects: saved.projects ?? defaults.projects,
      conversations: saved.conversations ?? defaults.conversations,
      prefs: { ...defaults.prefs, ...saved.prefs, blacklist: saved.prefs?.blacklist?.length ? saved.prefs.blacklist : DEFAULT_BLACKLIST },
      mcpApprovals: saved.mcpApprovals ?? {}
    };
  }

  /** 延迟 300ms 合并写入；先写临时文件再改名，避免写一半断电把文件写坏 */
  save(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(), 300);
  }

  saveNow(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  addProject(projectPath: string): Project {
    const existing = this.state.projects.find(p => samePath(p.path, projectPath));
    if (existing) return existing;
    const project: Project = { path: projectPath, name: path.basename(projectPath) || projectPath, addedAt: Date.now() };
    this.state.projects.push(project);
    this.save();
    return project;
  }

  removeProject(projectPath: string): void {
    this.state.projects = this.state.projects.filter(p => !samePath(p.path, projectPath));
    this.state.conversations = this.state.conversations.filter(c => !samePath(c.projectPath, projectPath));
    this.save();
  }

  newConversation(projectPath: string): ConversationMeta {
    const { defaultMode, defaultModel, defaultEffort } = this.state.prefs;
    const now = Date.now();
    const meta: ConversationMeta = {
      id: randomUUID(), projectPath, title: '新对话', createdAt: now, updatedAt: now,
      mode: defaultMode, model: defaultModel, effort: defaultEffort
    };
    this.state.conversations.push(meta);
    this.save();
    return meta;
  }

  conversation(id: string): ConversationMeta | undefined {
    return this.state.conversations.find(c => c.id === id);
  }

  updateConversation(meta: ConversationMeta): void {
    const i = this.state.conversations.findIndex(c => c.id === meta.id);
    if (i >= 0) this.state.conversations[i] = { ...meta };
    this.save();
  }

  removeConversation(id: string): void {
    this.state.conversations = this.state.conversations.filter(c => c.id !== id);
    this.save();
  }

  setPrefs(patch: Partial<Prefs>): void {
    this.state.prefs = { ...this.state.prefs, ...patch };
    this.save();
  }

  setMcpApproval(projectPath: string, name: string, approved: boolean): void {
    const key = normPath(projectPath);
    this.state.mcpApprovals[key] = { ...this.state.mcpApprovals[key], [name]: approved };
    this.save();
  }

  mcpApprovals(projectPath: string): Record<string, boolean> {
    return this.state.mcpApprovals[normPath(projectPath)] ?? {};
  }
}

export const normPath = (p: string) => path.resolve(p).toLowerCase();
export const samePath = (a: string, b: string) => normPath(a) === normPath(b);
