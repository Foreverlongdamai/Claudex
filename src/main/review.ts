// 改动面板的“上一轮”和文件监视。
//
// 上一轮：每一轮开始（用户发消息）和结束（收到 result）时给工作区拍快照（git 树对象），比较两个快照就是这一轮改了什么。
// 用快照而不是只看 Claude 的编辑记录，这样 Claude 用命令改的文件、新建和删除的文件都算进去。
// 快照的 ID 记在 userData/claudex-turns.json；树对象没有被引用，git gc 要两周后才可能清掉，够用了。
// 注意：同一个项目里两个对话同时在改文件时，各自的“上一轮”会混进对方的改动（C3 每个对话一个 worktree 之后就没这个问题了）。
//
// 文件监视：同时只监视一个仓库（当前对话的），有变化时通知界面刷新改动统计和面板。
import fs from 'node:fs';
import path from 'node:path';
import type { ConvEvent, GitDiffResult, GitEvent } from '../shared/types';
import { repoRoot, revertToTree, snapshot, treeDiff, type Trash } from './git';

interface Turn {
  root: string;
  before: string;
  after: string;
  at: number;
  /** 撤销过一部分以后：这一轮原来改过的文件（之后只看这些文件还剩下的改动） */
  paths?: string[];
}

type Snap = { root: string; tree: string } | null;

/** 这些路径的变化不用刷新：git 内部的对象和日志、依赖目录、缓存 */
const IGNORE = /(^|\/)(node_modules|__pycache__|\.venv|\.pytest_cache)\/|^\.git\/(objects|logs|lfs|modules|worktrees|hooks|info|fsmonitor--daemon)(\/|$)|^\.git\/.*\.lock$|^\.git\/(FETCH_HEAD|ORIG_HEAD)$/;

const hhmm = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

export class ReviewManager {
  private turns: Record<string, Turn> = {};
  /** 这一轮（或者下一轮）的起点快照 */
  private starts = new Map<string, Promise<Snap>>();
  /** 正在回复的对话 */
  private running = new Set<string>();
  private file: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private watcher: fs.FSWatcher | null = null;
  private watchRoot: string | null = null;
  private dirtyTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string, private emit: (ev: GitEvent) => void, private log: (line: string) => void) {
    this.file = path.join(dataDir, 'claudex-turns.json');
    try {
      this.turns = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.turns = {};
    }
  }

  private save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 300);
  }

  saveNow(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.turns));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (e) {
      this.log(`保存上一轮记录失败：${e instanceof Error ? e.message : e}`);
    }
  }

  private snap(cwd: string): Promise<Snap> {
    return snapshot(cwd).catch(e => {
      this.log(`拍快照失败（${cwd}）：${e instanceof Error ? e.message : e}`);
      return null;
    });
  }

  /** 用户发消息：这一轮开始。正在回复时追加的消息算在同一轮里 */
  async turnStart(convId: string, cwd: string): Promise<void> {
    if (this.running.has(convId) && this.starts.has(convId)) return;
    this.running.add(convId);
    const p = this.snap(cwd);
    this.starts.set(convId, p);
    // 一般几百毫秒；仓库特别大时最多等 4 秒，不耽误发消息（Claude 第一次改文件至少也要好几秒）
    await Promise.race([p, new Promise(r => setTimeout(r, 4000))]);
  }

  /** 一轮结束：拍结束快照，记下这一轮 */
  async turnEnd(convId: string): Promise<void> {
    const startP = this.starts.get(convId);
    this.running.delete(convId);
    if (!startP) return;
    const start = await startP;
    if (!start) return;
    const end = await this.snap(start.root);
    if (!end) return;
    this.turns[convId] = { root: start.root, before: start.tree, after: end.tree, at: Date.now() };
    this.save();
    // 排队的下一条消息会直接接着跑（没有新的“发送”），下一轮就从这里算起
    if (this.starts.get(convId) === startP) this.starts.set(convId, Promise.resolve(end));
    this.emit({ kind: 'turn', convId });
  }

  /** 对话进程的事件：收到 result 就是一轮结束；进程出错也算结束 */
  onConvEvent(ev: ConvEvent): void {
    if (ev.kind === 'sdk' && ev.msg.type === 'result' && !(ev.msg as { parent_tool_use_id?: string }).parent_tool_use_id) void this.turnEnd(ev.convId);
    else if (ev.kind === 'status' && ev.status === 'error' && this.running.has(ev.convId)) void this.turnEnd(ev.convId);
  }

  forget(convId: string): void {
    delete this.turns[convId];
    this.starts.delete(convId);
    this.running.delete(convId);
    this.save();
  }

  /** 这一轮还在进行时用起点快照，否则用上一轮的 */
  private async base(convId: string): Promise<{ root: string; before: string; after: string | null; at?: number; paths?: string[]; live: boolean } | null> {
    if (this.running.has(convId)) {
      const start = await this.starts.get(convId);
      if (start) return { root: start.root, before: start.tree, after: null, live: true };
    }
    const t = this.turns[convId];
    return t ? { ...t, live: false } : null;
  }

  async diff(convId: string | null, cwd: string): Promise<GitDiffResult> {
    const r: GitDiffResult = { scope: 'turn', desc: 'Claude 上一轮回复里改的文件', files: [] };
    if (!convId) return { ...r, empty: '新对话还没有回复过' };
    const b = await this.base(convId);
    if (!b) return { ...r, empty: (await repoRoot(cwd)) ? '这个对话还没有改过文件' : '这个项目还不是 Git 仓库' };
    try {
      if (b.live) {
        const now = await this.snap(b.root);
        if (!now) return { ...r, empty: '读不到现在的改动' };
        return { ...r, desc: '这一轮（还在进行）到现在为止改的文件', live: true, files: await treeDiff(b.root, b.before, now.tree), empty: '这一轮还没有改文件' };
      }
      let files = await treeDiff(b.root, b.before, b.after!);
      if (b.paths) {
        const keep = new Set(b.paths);
        files = files.filter(f => keep.has(f.path) || (f.oldPath && keep.has(f.oldPath)));
      }
      return {
        ...r,
        desc: `Claude 上一轮回复里改的文件（${hhmm(b.at!)} 结束${b.paths ? '，撤销过一部分' : ''}）`,
        files,
        empty: b.paths ? '上一轮的改动都撤销了' : '上一轮没有改文件'
      };
    } catch (e) {
      this.log(`上一轮的 diff 出错：${e instanceof Error ? e.message : e}`);
      return { ...r, empty: '上一轮的记录已经失效了（可能被 git 清理掉了）' };
    }
  }

  /** 撤销上一轮对这些文件的改动 */
  async revert(convId: string | null, paths: string[], trash: Trash): Promise<void> {
    const b = convId ? await this.base(convId) : null;
    if (!b) throw new Error('没有上一轮的记录');
    await revertToTree(b.root, b.before, paths, trash);
    // 撤销以后，“上一轮”显示这一轮原来改过的文件还剩下的改动（全部撤销了就是空的）
    const t = convId ? this.turns[convId] : undefined;
    if (!b.live && t) {
      const original = t.paths ?? (await treeDiff(t.root, t.before, t.after)).flatMap(f => (f.oldPath ? [f.path, f.oldPath] : [f.path]));
      const now = await this.snap(t.root);
      if (now) {
        this.turns[convId!] = { ...t, after: now.tree, paths: original };
        this.save();
      }
    }
  }

  // ---------------- 文件监视 ----------------

  async watch(cwd: string | null): Promise<void> {
    const root = cwd ? await repoRoot(cwd) : null;
    if (root === this.watchRoot) return;
    this.watcher?.close();
    this.watcher = null;
    this.watchRoot = root;
    if (!root) return;
    try {
      this.watcher = fs.watch(root, { recursive: true }, (_ev, file) => {
        const f = String(file ?? '').replace(/\\/g, '/');
        if (IGNORE.test(f)) return;
        if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
        this.dirtyTimer = setTimeout(() => this.emit({ kind: 'dirty', root }), 350);
      });
      this.watcher.on('error', e => this.log(`监视文件出错（${root}）：${e.message}`));
    } catch (e) {
      this.log(`监视文件失败（${root}）：${e instanceof Error ? e.message : e}`);
    }
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
    this.saveNow();
  }
}
