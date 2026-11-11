// 一个对话 = 一个 Claude Code 进程（SDK 的流式输入模式）。
// M0 的发现都在这里落实：
//   - 每次都显式传 permissionMode（不传会继承命令行全局设置里的 bypass）
//   - 启动时打开 allowDangerouslySkipPermissions（否则中途切不到完全访问），但模式仍是 default
//   - 设 CLAUDE_CODE_GIT_BASH_PATH（由 sessionEnv 负责）
//   - 没批准的项目 MCP 服务器用 disabledMcpjsonServers 拦住
//   - 保底黑名单用 PreToolUse hook，完全访问下也生效
import { randomUUID } from 'node:crypto';
import {
  query,
  type CanUseTool,
  type HookCallback,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk';
import type {
  BlacklistRule, ConvEvent, ConvStatus, ConversationMeta, Effort, ImageAttachment, ModeId,
  PermissionDecision, PermissionRequest, SdkMessageLike, UsageInfo
} from '../../shared/types';
import { matchBlacklist } from '../guard/blacklist';
import { SDK_MODE, skillsModeDecision, wrapForMode } from '../guard/modes';

export interface SessionDeps {
  env: () => Record<string, string | undefined>;
  blacklist: () => BlacklistRule[];
  disabledMcp: (projectPath: string) => string[];
  emit: (ev: ConvEvent) => void;
  saveMeta: (meta: ConversationMeta) => void;
  log: (line: string) => void;
}

/** 流式输入：一个可以不断往里推消息的异步队列 */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private buf: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(msg: SDKUserMessage): void {
    this.buf.push(msg);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      if (this.buf.length) { yield this.buf.shift()!; continue; }
      if (this.closed) return;
      await new Promise<void>(r => { this.wake = r; });
      this.wake = null;
    }
  }
}

interface Pending {
  request: PermissionRequest;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  resolve: (r: PermissionResult) => void;
}

/** 把“总是允许”会加的规则写成人能看懂的一句话 */
function describeSuggestions(suggestions?: PermissionUpdate[]): string | undefined {
  if (!suggestions?.length) return undefined;
  const parts: string[] = [];
  for (const s of suggestions) {
    if (s.type === 'addRules' || s.type === 'replaceRules') {
      for (const r of s.rules) parts.push(r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName);
    } else if (s.type === 'setMode') {
      parts.push(s.mode === 'acceptEdits' ? '本对话自动接受编辑' : `切换到 ${s.mode}`);
    } else if (s.type === 'addDirectories') {
      parts.push(`允许访问 ${s.directories.join('、')}`);
    }
  }
  return parts.join('，') || undefined;
}

function makeTitle(text: string): string {
  const line = text.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? '新对话';
  return line.length > 30 ? line.slice(0, 30) + '…' : line;
}

export class ConvSession {
  status: ConvStatus;
  usage?: UsageInfo;
  lastActive = Date.now();
  private q: Query | null = null;
  private input: InputQueue | null = null;
  private pending = new Map<string, Pending>();

  constructor(public meta: ConversationMeta, private deps: SessionDeps) {
    this.status = meta.sessionId ? 'dormant' : 'new';
  }

  get live(): boolean {
    return this.q !== null;
  }

  /** 正在回复或者在等审批时，不能被回收 */
  get busy(): boolean {
    return this.status === 'running' || this.status === 'starting' || this.pending.size > 0;
  }

  pendingRequests(): PermissionRequest[] {
    return [...this.pending.values()].map(p => p.request);
  }

  private setStatus(status: ConvStatus, error?: string): void {
    this.status = status;
    this.deps.emit({ kind: 'status', convId: this.meta.id, status, error });
  }

  private persist(): void {
    this.deps.saveMeta(this.meta);
    this.deps.emit({ kind: 'meta', convId: this.meta.id, meta: { ...this.meta } });
  }

  private start(): void {
    const meta = this.meta;
    const input = new InputQueue();
    this.input = input;
    this.setStatus('starting');
    const q = query({
      prompt: input,
      options: {
        cwd: meta.projectPath,
        model: meta.model,
        effort: meta.effort,
        permissionMode: SDK_MODE[meta.mode],
        allowDangerouslySkipPermissions: true,
        ...(meta.sessionId ? { resume: meta.sessionId } : {}),
        includePartialMessages: true,
        env: this.deps.env(),
        canUseTool: this.canUseTool,
        hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [this.guardHook] }] },
        settings: { disabledMcpjsonServers: this.deps.disabledMcp(meta.projectPath) },
        stderr: (d: string) => this.deps.log(`[${meta.id.slice(0, 8)}] ${d.trimEnd()}`)
      }
    });
    this.q = q;
    void this.pump(q);
  }

  private async pump(q: Query): Promise<void> {
    try {
      for await (const msg of q) this.onMessage(msg);
      if (this.q === q) {
        this.q = null;
        this.setStatus('dormant');
      }
    } catch (e) {
      if (this.q !== q) return; // 已经被 close() 换掉了
      this.q = null;
      this.cancelAllPending('对话进程出错了');
      const message = e instanceof Error ? e.message : String(e);
      this.deps.log(`[${this.meta.id.slice(0, 8)}] 进程出错：${message}`);
      this.setStatus('error', message);
    }
  }

  private onMessage(msg: SDKMessage): void {
    this.lastActive = Date.now();
    if (msg.type === 'system' && msg.subtype === 'init') {
      if (msg.session_id && msg.session_id !== this.meta.sessionId) {
        this.meta.sessionId = msg.session_id;
        this.persist();
      }
      if (this.status === 'starting') this.setStatus('running');
    }
    this.deps.emit({ kind: 'sdk', convId: this.meta.id, msg: msg as unknown as SdkMessageLike });
    if (msg.type === 'result') {
      this.meta.updatedAt = Date.now();
      this.persist();
      this.setStatus('idle');
      void this.refreshUsage();
    }
  }

  private async refreshUsage(): Promise<void> {
    try {
      const u = await this.q?.getContextUsage({ detail: 'summary' });
      if (!u) return;
      this.usage = { percentage: u.percentage, totalTokens: u.totalTokens, maxTokens: u.maxTokens };
      this.deps.emit({ kind: 'usage', convId: this.meta.id, usage: this.usage });
    } catch (e) {
      this.deps.log(`[${this.meta.id.slice(0, 8)}] 读上下文用量失败：${e instanceof Error ? e.message : e}`);
    }
  }

  async send(text: string, images: ImageAttachment[] = []): Promise<void> {
    if (!this.q) this.start();
    const body = wrapForMode(this.meta.mode, text);
    const content = images.length
      ? [
          ...images.map(img => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mediaType as 'image/png', data: img.data } })),
          { type: 'text' as const, text: body }
        ]
      : body;
    if (this.meta.title === '新对话') this.meta.title = makeTitle(text);
    this.meta.updatedAt = Date.now();
    this.persist();
    this.input!.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
    this.lastActive = Date.now();
    if (this.status !== 'starting') this.setStatus('running');
  }

  async interrupt(): Promise<void> {
    if (!this.q) return;
    try {
      await this.q.interrupt();
    } catch (e) {
      this.deps.log(`[${this.meta.id.slice(0, 8)}] 停止失败：${e instanceof Error ? e.message : e}`);
    }
  }

  async setMode(mode: ModeId): Promise<void> {
    this.meta.mode = mode;
    this.persist();
    if (this.q) await this.q.setPermissionMode(SDK_MODE[mode]);
  }

  async setModel(model: string, effort: Effort): Promise<void> {
    const modelChanged = model !== this.meta.model;
    this.meta.model = model;
    this.meta.effort = effort;
    this.persist();
    if (!this.q) return; // 下次启动时用新设置
    if (modelChanged) await this.q.setModel(model);
    await this.q.applyFlagSettings({ effortLevel: effort });
  }

  // ---------------- 审批 ----------------

  private canUseTool: CanUseTool = async (toolName, input, opts) => {
    // Skills 配置模式：按规则自动放行或拒绝；提问和计划仍然要用户回答
    if (this.meta.mode === 'skills' && toolName !== 'AskUserQuestion' && toolName !== 'ExitPlanMode') {
      const d = skillsModeDecision(toolName, input, this.meta.projectPath);
      if (d.behavior === 'allow') return { behavior: 'allow', updatedInput: input };
      if (d.behavior === 'deny') return { behavior: 'deny', message: d.message };
    }
    const requestId = randomUUID();
    const request: PermissionRequest = {
      requestId, toolUseId: opts.toolUseID, toolName, input,
      title: opts.title, displayName: opts.displayName, description: opts.description,
      decisionReason: opts.decisionReason, blockedPath: opts.blockedPath,
      canAlways: !!opts.suggestions?.length && !opts.suppressAlwaysAllowRule,
      alwaysLabel: describeSuggestions(opts.suggestions)
    };
    return new Promise<PermissionResult>(resolve => {
      // 用户点了停止、或者进程要关：SDK 会发 abort，审批卡片要收回
      const onAbort = () => {
        if (!this.pending.delete(requestId)) return;
        this.deps.emit({ kind: 'permission-cancel', convId: this.meta.id, requestId });
        resolve({ behavior: 'deny', message: '已取消' });
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(requestId, {
        request, input, suggestions: opts.suggestions,
        resolve: r => { opts.signal.removeEventListener('abort', onAbort); resolve(r); }
      });
      this.deps.emit({ kind: 'permission', convId: this.meta.id, request });
    });
  };

  async respond(decision: PermissionDecision): Promise<void> {
    const p = this.pending.get(decision.requestId);
    if (!p) return;
    this.pending.delete(decision.requestId);
    if (decision.behavior === 'deny') {
      p.resolve({ behavior: 'deny', message: decision.message?.trim() || '用户拒绝了这个操作。' });
    } else {
      p.resolve({
        behavior: 'allow',
        updatedInput: decision.updatedInput ?? p.input,
        ...(decision.behavior === 'always' && p.suggestions ? { updatedPermissions: p.suggestions } : {})
      });
    }
    if (decision.nextMode && decision.nextMode !== this.meta.mode) {
      await this.setMode(decision.nextMode);
      this.deps.emit({ kind: 'mode', convId: this.meta.id, mode: decision.nextMode });
    }
  }

  private cancelAllPending(message: string): void {
    for (const [id, p] of this.pending) {
      p.resolve({ behavior: 'deny', message });
      this.deps.emit({ kind: 'permission-cancel', convId: this.meta.id, requestId: id });
    }
    this.pending.clear();
  }

  // ---------------- 保底黑名单 ----------------

  private guardHook: HookCallback = async input => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const hit = matchBlacklist(input.tool_name, input.tool_input, this.deps.blacklist());
    if (!hit) return {};
    this.deps.emit({ kind: 'blocked', convId: this.meta.id, toolName: input.tool_name, rule: hit.rule.label, detail: hit.detail });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Claudex 保底黑名单拦截：${hit.rule.label}。不要尝试用其他命令绕过，请向用户说明情况。`
      }
    };
  };

  /** 关掉进程（回收内存或 App 退出）。对话记录还在，下次发消息会自动续接。 */
  close(): void {
    const q = this.q;
    if (!q) return;
    this.q = null;
    this.cancelAllPending('App 关闭了这个对话的进程');
    this.input?.close();
    try { q.close(); } catch { /* 已经结束 */ }
    this.setStatus(this.meta.sessionId ? 'dormant' : 'new');
  }
}
