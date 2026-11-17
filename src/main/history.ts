// 对话历史（M2）：列出、搜索 Claude Code 的全部会话（包括命令行里的），打开接着聊、分叉、改名、导出。
// 不另存对话内容：会话列表和内容都用 SDK 的官方接口读 Claude Code 自己的记录（listSessions / getSessionMessages / forkSession）。
import fs from 'node:fs';
import { forkSession, getSessionMessages, listSessions, renameSession } from '@anthropic-ai/claude-agent-sdk';
import type { ConversationMeta, HistorySearchHit, HistorySession } from '../shared/types';
import { convCwd, inWorktree } from '../shared/conv';
import { searchableText, snippet, toHtml, toMarkdown, toTranscript, type SessionLike, type TranscriptEntry } from '../shared/history.ts';
import type { Store } from './store';
import { samePath } from './store';

/** 全文搜索最多读多少个最近的会话（每个都要读一遍文件） */
const MAX_FULLTEXT = 400;

export interface HistoryDeps {
  store: Store;
  emit: (ev: { kind: 'meta'; convId: string; meta: ConversationMeta }) => void;
  log: (line: string) => void;
}

export class HistoryManager {
  /** 会话 ID → 读过的文字稿（会话文件改过就重读） */
  private cache = new Map<string, { lastModified: number; text: string; plain: string }>();

  constructor(private deps: HistoryDeps) {}

  /** 某个会话在 Claudex 里对应的对话 */
  private convOf(sessionId: string): ConversationMeta | undefined {
    return this.deps.store.state.conversations.find(c => c.sessionId === sessionId);
  }

  /** 项目（不传就是全部项目）的会话，按最后修改时间从新到旧 */
  async list(projectPath: string | null): Promise<HistorySession[]> {
    const projects = this.deps.store.state.projects.filter(p => !projectPath || samePath(p.path, projectPath));
    const seen = new Set<string>();
    const out: HistorySession[] = [];
    for (const p of projects) {
      if (!fs.existsSync(p.path)) continue;
      let list: Awaited<ReturnType<typeof listSessions>> = [];
      try {
        list = await listSessions({ dir: p.path, includeWorktrees: true, limit: 1000 });
      } catch (e) {
        this.deps.log(`列出会话失败（${p.path}）：${e instanceof Error ? e.message : e}`);
      }
      for (const s of list) {
        if (seen.has(s.sessionId)) continue;
        seen.add(s.sessionId);
        const conv = this.convOf(s.sessionId);
        out.push({
          sessionId: s.sessionId, projectPath: p.path, title: conv?.title ?? (s.customTitle || s.summary || s.firstPrompt || '（没有标题）'),
          firstPrompt: s.firstPrompt, lastModified: s.lastModified, createdAt: s.createdAt, cwd: s.cwd, gitBranch: s.gitBranch,
          convId: conv?.id, employee: conv?.employee?.id, automation: conv?.automation?.name
        });
      }
    }
    return out.sort((a, b) => b.lastModified - a.lastModified);
  }

  /** 读一个会话的文字稿（缓存） */
  private async text(s: HistorySession): Promise<{ text: string; plain: string }> {
    const hit = this.cache.get(s.sessionId);
    if (hit && hit.lastModified === s.lastModified) return hit;
    let entries: TranscriptEntry[] = [];
    try {
      const msgs = await getSessionMessages(s.sessionId, { dir: s.cwd && fs.existsSync(s.cwd) ? s.cwd : s.projectPath });
      entries = toTranscript(msgs as unknown as SessionLike[]);
    } catch {
      // 读不了就当空的
    }
    const plain = entries.map(e => [e.text, ...e.files].join('\n')).join('\n');
    const v = { lastModified: s.lastModified, text: searchableText(entries), plain };
    this.cache.set(s.sessionId, v);
    return v;
  }

  /** 搜索：标题和第一句话先找，再找对话内容（最近的 MAX_FULLTEXT 个会话） */
  async search(query: string, projectPath: string | null): Promise<HistorySearchHit[]> {
    const q = query.trim().toLowerCase();
    const all = await this.list(projectPath);
    if (!q) return all.map(session => ({ session, where: 'title' as const }));
    const hits: HistorySearchHit[] = [];
    const rest: HistorySession[] = [];
    for (const s of all) {
      if (s.title.toLowerCase().includes(q) || (s.firstPrompt ?? '').toLowerCase().includes(q)) hits.push({ session: s, where: 'title', snippet: snippet(s.firstPrompt ?? '', q) ?? undefined });
      else rest.push(s);
    }
    const batch = 8;
    const candidates = rest.slice(0, MAX_FULLTEXT);
    for (let i = 0; i < candidates.length; i += batch) {
      const part = candidates.slice(i, i + batch);
      const texts = await Promise.all(part.map(s => this.text(s)));
      part.forEach((s, j) => {
        if (texts[j].text.includes(q)) hits.push({ session: s, where: 'content', snippet: snippet(texts[j].plain, q) ?? undefined });
      });
    }
    return hits;
  }

  /** 打开一个会话：已经在 Claudex 里就返回那个对话，否则（命令行的会话）建一个对话接上它 */
  async open(sessionId: string, projectPath: string): Promise<ConversationMeta> {
    const existing = this.convOf(sessionId);
    if (existing) return existing;
    const s = (await this.list(projectPath)).find(x => x.sessionId === sessionId);
    if (!s) throw new Error('找不到这个会话（可能已经被删了）');
    const store = this.deps.store;
    const base = store.newConversation(projectPath);
    // 会话在项目的子文件夹或者别的 worktree 里开的：就在那里接着聊（Claude Code 按目录找会话）
    const cwd = s.cwd && fs.existsSync(s.cwd) && !samePath(s.cwd, projectPath) ? s.cwd : undefined;
    const meta: ConversationMeta = {
      ...base, sessionId, title: s.title.slice(0, 80), createdAt: s.createdAt ?? s.lastModified, updatedAt: s.lastModified,
      ...(cwd ? { workdir: cwd } : {})
    };
    store.updateConversation(meta);
    this.deps.emit({ kind: 'meta', convId: meta.id, meta });
    this.deps.log(`打开命令行的会话：${meta.title}（${sessionId}）`);
    return meta;
  }

  /** 分叉：复制一份会话记录接着聊，原来的对话不动 */
  async fork(convId: string): Promise<ConversationMeta> {
    const store = this.deps.store;
    const src = store.conversation(convId);
    if (!src) throw new Error('对话不存在');
    if (!src.sessionId) throw new Error('这个对话还没有内容，不用分叉');
    const title = `${src.title}（分叉）`;
    const { sessionId } = await forkSession(src.sessionId, { dir: convCwd(src), title });
    const base = store.newConversation(src.projectPath);
    // 在 worktree 里的对话：分叉出来的在原来的目录里接着（共用那个 worktree 的话，删一个就把另一个的目录删了，所以只记目录不记 worktree）
    const dir = convCwd(src);
    const meta: ConversationMeta = {
      ...base, sessionId, title, mode: src.mode, model: src.model, effort: src.effort,
      ...(src.employee ? { employee: src.employee } : {}),
      ...(!samePath(dir, src.projectPath) && (inWorktree(src) || src.workdir) ? { workdir: dir } : {})
    };
    store.updateConversation(meta);
    this.deps.emit({ kind: 'meta', convId: meta.id, meta });
    this.deps.log(`分叉对话：${src.title} → ${sessionId}`);
    return meta;
  }

  /** 改名：Claudex 里的标题，同时写进 Claude Code 的会话（命令行 /resume 里也是这个名字） */
  async rename(convId: string, title: string): Promise<ConversationMeta> {
    const store = this.deps.store;
    const meta = store.conversation(convId);
    if (!meta) throw new Error('对话不存在');
    const t = title.trim().slice(0, 120);
    if (!t) throw new Error('名字不能为空');
    const next = { ...meta, title: t };
    store.updateConversation(next);
    this.deps.emit({ kind: 'meta', convId, meta: next });
    if (meta.sessionId) await renameSession(meta.sessionId, t, { dir: convCwd(meta) }).catch(e => this.deps.log(`会话改名失败：${e instanceof Error ? e.message : e}`));
    return next;
  }

  pin(convId: string, pinned: boolean): ConversationMeta {
    const store = this.deps.store;
    const meta = store.conversation(convId);
    if (!meta) throw new Error('对话不存在');
    const next = { ...meta, pinned: pinned || undefined };
    store.updateConversation(next);
    this.deps.emit({ kind: 'meta', convId, meta: next });
    return next;
  }

  /** 导出成 Markdown 或 HTML 的文字 */
  async export(convId: string, format: 'md' | 'html'): Promise<{ name: string; content: string }> {
    const meta = this.deps.store.conversation(convId);
    if (!meta) throw new Error('对话不存在');
    if (!meta.sessionId) throw new Error('这个对话还没有内容');
    const msgs = await getSessionMessages(meta.sessionId, { dir: convCwd(meta) });
    const entries = toTranscript(msgs as unknown as SessionLike[]);
    const info = { title: meta.title, project: this.deps.store.project(meta.projectPath)?.name ?? meta.projectPath, at: Date.now(), model: meta.model };
    const safe = meta.title.replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 60) || '对话';
    return { name: `${safe}.${format}`, content: format === 'md' ? toMarkdown(info, entries) : toHtml(info, entries) };
  }
}
