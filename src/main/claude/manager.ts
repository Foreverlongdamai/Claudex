// 管理所有对话的进程：按需启动、限制同时运行的数量（每个约 250 MB，M0 实测）、回收闲置的。
// 被回收的对话下次发消息时会用 resume 续接，上下文不会丢（M0 验证过）。
import { getSessionMessages, query, type Query } from '@anthropic-ai/claude-agent-sdk';
import os from 'node:os';
import type { CommandInfo, ConvEvent, ImageAttachment, ModelOption, OpenedConversation, SdkMessageLike } from '../../shared/types';
import type { Store } from '../store';
import { ConvSession, type SessionDeps } from './session';

/** 起一个空闲的 Claude Code 进程，只发控制请求（查模型、查命令），不花 token */
async function withProbe<T>(cwd: string, env: Record<string, string | undefined>, fn: (q: Query) => Promise<T>): Promise<T> {
  const idle = { async *[Symbol.asyncIterator]() { await new Promise(() => {}); } };
  const q = query({ prompt: idle as AsyncIterable<never>, options: { cwd, env, permissionMode: 'default', persistSession: false } });
  try {
    return await fn(q);
  } finally {
    q.close();
  }
}

export class SessionManager {
  private sessions = new Map<string, ConvSession>();
  private models: Promise<ModelOption[]> | null = null;
  private commands = new Map<string, { at: number; list: CommandInfo[] }>();

  constructor(private store: Store, private deps: Omit<SessionDeps, 'saveMeta'>) {}

  private session(convId: string): ConvSession {
    let s = this.sessions.get(convId);
    if (!s) {
      const meta = this.store.conversation(convId);
      if (!meta) throw new Error(`找不到对话 ${convId}`);
      s = new ConvSession({ ...meta }, { ...this.deps, saveMeta: m => this.store.updateConversation(m) });
      this.sessions.set(convId, s);
    }
    return s;
  }

  /** 要启动新进程前，超出上限就回收最久没用、而且没在忙的对话 */
  private makeRoom(except: ConvSession): void {
    const max = Math.max(1, this.store.state.prefs.maxLiveSessions);
    const live = [...this.sessions.values()].filter(s => s.live && s !== except);
    if (live.length < max) return;
    const idle = live.filter(s => !s.busy).sort((a, b) => a.lastActive - b.lastActive);
    for (const s of idle.slice(0, live.length - max + 1)) {
      this.deps.log(`回收闲置对话进程：${s.meta.title}`);
      s.close();
    }
  }

  async open(convId: string): Promise<OpenedConversation> {
    const s = this.session(convId);
    let history: SdkMessageLike[] = [];
    if (s.meta.sessionId) {
      try {
        const msgs = await getSessionMessages(s.meta.sessionId, { dir: s.meta.projectPath });
        history = msgs.map(m => ({ type: m.type, uuid: m.uuid, message: m.message, parent_tool_use_id: m.parent_tool_use_id }));
      } catch (e) {
        this.deps.log(`读取历史失败（${s.meta.title}）：${e instanceof Error ? e.message : e}`);
      }
    }
    return { meta: { ...s.meta }, status: s.status, history, pending: s.pendingRequests(), usage: s.usage };
  }

  async send(convId: string, text: string, images?: ImageAttachment[]): Promise<void> {
    const s = this.session(convId);
    if (!s.live) this.makeRoom(s);
    await s.send(text, images);
  }

  interrupt(convId: string) { return this.sessions.get(convId)?.interrupt(); }
  setMode(convId: string, mode: Parameters<ConvSession['setMode']>[0]) { return this.session(convId).setMode(mode); }
  setModel(convId: string, model: string, effort: Parameters<ConvSession['setModel']>[1]) { return this.session(convId).setModel(model, effort); }
  respond(convId: string, decision: Parameters<ConvSession['respond']>[0]) { return this.sessions.get(convId)?.respond(decision); }

  delete(convId: string): void {
    this.sessions.get(convId)?.close();
    this.sessions.delete(convId);
  }

  closeAll(): void {
    for (const s of this.sessions.values()) s.close();
  }

  listModels(): Promise<ModelOption[]> {
    this.models ??= withProbe(os.homedir(), this.deps.env(), q => q.supportedModels())
      .then(list => list
        .filter(m => m.value !== 'default')
        .map(m => ({
          value: m.value,
          displayName: m.displayName,
          description: m.description,
          efforts: m.supportedEffortLevels ?? [],
          supportsFast: !!m.supportsFastMode
        })))
      .catch(e => {
        this.models = null; // 失败了下次再试
        throw e;
      });
    return this.models;
  }

  /** 项目里能用的斜杠命令和 Skills（按项目缓存 5 分钟） */
  async listCommands(projectPath: string): Promise<CommandInfo[]> {
    const cached = this.commands.get(projectPath);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.list;
    const list = (await withProbe(projectPath, this.deps.env(), q => q.supportedCommands()))
      .map(c => ({ name: c.name, description: c.description ?? '' }));
    this.commands.set(projectPath, { at: Date.now(), list });
    return list;
  }
}

export type { ConvEvent };
