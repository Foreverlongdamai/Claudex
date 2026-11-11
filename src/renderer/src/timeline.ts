// 把 SDK 消息流整理成界面上的时间线（纯函数，不依赖 React，方便测试）。
// 实时对话：先收到逐字的 stream_event，再收到完整的 assistant 消息（每个内容块一条）；
// 打开历史对话：只有完整消息（来自 getSessionMessages）。两种来源走同一套逻辑。
import type { PermissionRequest, SdkMessageLike } from '@shared/types';

export type ToolStatus = 'running' | 'done' | 'error' | 'denied';

export type Item =
  | { kind: 'user'; id: string; text: string; images: number; skillsMode: boolean }
  | { kind: 'text'; id: string; msgId: string; text: string; streaming: boolean }
  | { kind: 'thinking'; id: string; msgId: string; text: string; startedAt: number; endedAt?: number }
  | {
      kind: 'tool'; id: string; name: string; input: Record<string, unknown>; status: ToolStatus;
      output?: string; extra?: unknown; startedAt: number; endedAt?: number; subSteps: number;
    }
  | { kind: 'approval'; id: string; request: PermissionRequest; resolved?: 'allow' | 'always' | 'deny' | 'cancelled'; note?: string }
  | { kind: 'notice'; id: string; tone: 'info' | 'error' | 'blocked'; text: string; detail?: string }
  | { kind: 'turn-end'; id: string; durationMs: number; costUsd?: number; isError: boolean };

export interface InitInfo {
  model: string;
  permissionMode: string;
  claudeVersion: string;
  tools: string[];
  slashCommands: string[];
  skills: number;
  mcp: { name: string; status: string }[];
  fastState?: string;
}

export interface Timeline {
  items: Item[];
  /** 正在流式输出的消息：content block 下标 → 时间线条目 ID */
  stream: { msgId: string | null; blocks: Record<number, string> };
  init?: InitInfo;
}

export const emptyTimeline = (): Timeline => ({ items: [], stream: { msgId: null, blocks: {} } });

let seq = 0;
const uid = (p: string) => `${p}:${Date.now().toString(36)}:${(seq++).toString(36)}`;

/** Skills 配置模式会在消息前附加流程说明，显示时去掉 */
const MODE_WRAPPER = /^<claudex-mode name="([^"]+)">[\s\S]*?<\/claudex-mode>\s*/;

export function stripModeWrapper(text: string): { text: string; skillsMode: boolean } {
  const m = MODE_WRAPPER.exec(text);
  return m ? { text: text.slice(m[0].length), skillsMode: m[1] === 'skills' } : { text, skillsMode: false };
}

// ---------------- 小工具：不可变地改时间线 ----------------

function findIndex(items: Item[], id: string): number {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].id === id) return i;
  return -1;
}

function update<K extends Item['kind']>(t: Timeline, id: string, kind: K, fn: (it: Extract<Item, { kind: K }>) => Partial<Extract<Item, { kind: K }>>): Timeline {
  const i = findIndex(t.items, id);
  if (i < 0 || t.items[i].kind !== kind) return t;
  const items = t.items.slice();
  const cur = items[i] as Extract<Item, { kind: K }>;
  items[i] = { ...cur, ...fn(cur) };
  return { ...t, items };
}

const push = (t: Timeline, ...items: Item[]): Timeline => ({ ...t, items: [...t.items, ...items] });

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(c => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[图片]' : '')).filter(Boolean).join('\n');
}

const DENIED = /doesn't want to proceed|user rejected|用户拒绝|已取消|denied|Claudex 保底黑名单|blocked by|permission/i;

// ---------------- 本地事件 ----------------

export function addUser(t: Timeline, text: string, images: number, skillsMode: boolean): Timeline {
  return push(t, { kind: 'user', id: uid('user'), text, images, skillsMode });
}

export function addApproval(t: Timeline, request: PermissionRequest): Timeline {
  if (findIndex(t.items, request.requestId) >= 0) return t;
  return push(t, { kind: 'approval', id: request.requestId, request });
}

export function resolveApproval(t: Timeline, requestId: string, resolved: 'allow' | 'always' | 'deny' | 'cancelled', note?: string): Timeline {
  return update(t, requestId, 'approval', () => ({ resolved, note }));
}

export function addNotice(t: Timeline, tone: 'info' | 'error' | 'blocked', text: string, detail?: string): Timeline {
  return push(t, { kind: 'notice', id: uid('notice'), tone, text, detail });
}

/** 有没有还在等回答的审批 */
export const pendingApprovals = (t: Timeline) => t.items.filter(i => i.kind === 'approval' && !i.resolved).length;

// ---------------- SDK 消息 ----------------

export function applySdk(t: Timeline, msg: SdkMessageLike, live: boolean): Timeline {
  const m = msg as Record<string, any>;
  // 子代理内部的消息不单独显示，只给对应的子代理那一行计步数
  if (m.parent_tool_use_id) {
    if (m.type === 'assistant') {
      const steps = (m.message?.content ?? []).filter((b: any) => b.type === 'tool_use').length;
      if (steps) return update(t, m.parent_tool_use_id, 'tool', it => ({ subSteps: it.subSteps + steps }));
    }
    return t;
  }
  switch (m.type) {
    case 'system': return applySystem(t, m);
    case 'stream_event': return live ? applyStream(t, m.event) : t;
    case 'assistant': return applyAssistant(t, m);
    case 'user': return applyUser(t, m, live);
    case 'result': return applyResult(t, m);
    default: return t;
  }
}

function applySystem(t: Timeline, m: Record<string, any>): Timeline {
  if (m.subtype === 'init') {
    return {
      ...t,
      init: {
        model: m.model, permissionMode: m.permissionMode, claudeVersion: m.claude_code_version,
        tools: m.tools ?? [], slashCommands: m.slash_commands ?? [], skills: (m.skills ?? []).length,
        mcp: (m.mcp_servers ?? []).map((s: any) => ({ name: s.name, status: s.status })),
        fastState: m.fast_mode_state
      }
    };
  }
  if (m.subtype === 'compact_boundary') return addNotice(t, 'info', '上下文快满了，已自动压缩较早的对话');
  return t;
}

function applyStream(t: Timeline, ev: Record<string, any>): Timeline {
  if (!ev) return t;
  switch (ev.type) {
    case 'message_start':
      return { ...t, stream: { msgId: ev.message?.id ?? null, blocks: {} } };
    case 'content_block_start': {
      const msgId = t.stream.msgId ?? 'msg';
      const cb = ev.content_block ?? {};
      let item: Item | null = null;
      if (cb.type === 'text') item = { kind: 'text', id: `${msgId}:t${ev.index}`, msgId, text: cb.text ?? '', streaming: true };
      else if (cb.type === 'thinking' || cb.type === 'redacted_thinking') item = { kind: 'thinking', id: `${msgId}:k${ev.index}`, msgId, text: '', startedAt: Date.now() };
      else if ((cb.type === 'tool_use' || cb.type === 'server_tool_use') && findIndex(t.items, cb.id) < 0) {
        item = { kind: 'tool', id: cb.id, name: cb.name, input: {}, status: 'running', startedAt: Date.now(), subSteps: 0 };
      }
      const next = item ? push(t, item) : t;
      const id = item?.id ?? cb.id;
      return id ? { ...next, stream: { ...next.stream, blocks: { ...next.stream.blocks, [ev.index]: id } } } : next;
    }
    case 'content_block_delta': {
      const id = t.stream.blocks[ev.index];
      const d = ev.delta ?? {};
      if (!id) return t;
      if (d.type === 'text_delta') return update(t, id, 'text', it => ({ text: it.text + d.text }));
      if (d.type === 'thinking_delta') return update(t, id, 'thinking', it => ({ text: it.text + (d.thinking ?? '') }));
      return t;
    }
    case 'content_block_stop': {
      const id = t.stream.blocks[ev.index];
      return id ? update(t, id, 'thinking', it => ({ endedAt: it.endedAt ?? Date.now() })) : t;
    }
    default:
      return t;
  }
}

function applyAssistant(t: Timeline, m: Record<string, any>): Timeline {
  const msgId: string = m.message?.id ?? uid('msg');
  let next = t;
  for (const block of m.message?.content ?? []) {
    if (block.type === 'text') {
      // 先找同一条消息里还在流式输出的文字，用完整内容收尾；找不到就新加一条
      const live = next.items.find(i => i.kind === 'text' && i.msgId === msgId && i.streaming);
      if (live) next = update(next, live.id, 'text', () => ({ text: block.text, streaming: false }));
      else if (block.text?.trim()) {
        const n = next.items.filter(i => i.kind === 'text' && i.msgId === msgId).length;
        next = push(next, { kind: 'text', id: `${msgId}:t#${n}`, msgId, text: block.text, streaming: false });
      }
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      const existing = next.items.find(i => i.kind === 'thinking' && i.msgId === msgId);
      if (existing) next = update(next, existing.id, 'thinking', it => ({ endedAt: it.endedAt ?? Date.now(), text: block.thinking || it.text }));
      else next = push(next, { kind: 'thinking', id: `${msgId}:k#`, msgId, text: block.thinking ?? '', startedAt: Date.now(), endedAt: Date.now() });
    } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      if (findIndex(next.items, block.id) >= 0) next = update(next, block.id, 'tool', () => ({ input: block.input ?? {}, name: block.name }));
      else next = push(next, { kind: 'tool', id: block.id, name: block.name, input: block.input ?? {}, status: 'running', startedAt: Date.now(), subSteps: 0 });
    }
  }
  if (m.error) next = addNotice(next, 'error', `请求出错：${m.error}`);
  return next;
}

function applyUser(t: Timeline, m: Record<string, any>, live: boolean): Timeline {
  const content = m.message?.content;
  const results = Array.isArray(content) ? content.filter((b: any) => b?.type === 'tool_result') : [];
  if (results.length) {
    let next = t;
    results.forEach((b: any, i: number) => {
      const output = contentText(b.content);
      const denied = !!b.is_error && (DENIED.test(output) || hasDeniedApproval(next, b.tool_use_id));
      next = update(next, b.tool_use_id, 'tool', () => ({
        status: b.is_error ? (denied ? 'denied' : 'error') : 'done',
        output,
        extra: i === 0 ? m.tool_use_result : undefined,
        endedAt: Date.now()
      }));
    });
    return next;
  }
  // 实时对话里，用户自己的消息在发送时就已经加到时间线了
  if (live || m.isSynthetic || m.isReplay) return t;
  const raw = contentText(content);
  if (/^\[Request interrupted/i.test(raw)) return addNotice(t, 'info', '已停止');
  const { text, skillsMode } = stripModeWrapper(raw);
  if (!text.trim() || /^<(local-command|command-name|system-reminder)/.test(text.trim())) return t;
  const images = Array.isArray(content) ? content.filter((c: any) => c?.type === 'image').length : 0;
  return addUser(t, text.replace(/\[图片\]\n?/g, ''), images, skillsMode);
}

function hasDeniedApproval(t: Timeline, toolUseId: string): boolean {
  return t.items.some(i => i.kind === 'approval' && i.request.toolUseId === toolUseId && i.resolved === 'deny');
}

function applyResult(t: Timeline, m: Record<string, any>): Timeline {
  // 收尾：还在流式的文字、没结束的思考、没有结果的工具
  const now = Date.now();
  const items = t.items.map(it => {
    if (it.kind === 'text' && it.streaming) return { ...it, streaming: false };
    if (it.kind === 'thinking' && !it.endedAt) return { ...it, endedAt: now };
    if (it.kind === 'tool' && it.status === 'running' && m.subtype !== 'success') return { ...it, status: 'error' as const, endedAt: now };
    return it;
  });
  let next: Timeline = { ...t, items, stream: { msgId: null, blocks: {} } };
  if (m.subtype !== 'success') {
    const why = Array.isArray(m.errors) && m.errors.length ? m.errors.join('；') : m.result || m.subtype;
    const text = m.subtype === 'error_max_turns' ? '达到了单次对话的最大轮数' : m.subtype === 'error_max_budget_usd' ? '达到了花费上限' : '这一轮没有正常完成';
    next = addNotice(next, 'error', text, String(why ?? ''));
  } else if (m.is_error && m.result) {
    next = addNotice(next, 'error', String(m.result));
  }
  return push(next, { kind: 'turn-end', id: uid('end'), durationMs: m.duration_ms ?? 0, costUsd: m.total_cost_usd, isError: !!m.is_error });
}
