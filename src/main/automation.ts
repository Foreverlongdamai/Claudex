// 自动化（C4）：按计划让 Claude 自动跑任务。
// - 每次运行开一个新对话（默认在新的 worktree 里，不碰本地文件），把“要做什么”发给 Claude
// - 跑完（或者暂停等用户审批）进审查队列；用户在“自动化”页面打开这次运行的对话看结果、审批、接着聊
// - App 关着的时候错过的运行，下次打开时补跑一次（不管错过几次都只补一次）
// - 记录存在 userData/claudex-automations.json；对话本身照常由 Claude Code 保存
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Automation, AutomationRun, AutomationState, ConvEvent, ConversationMeta } from '../shared/types';
import { checkSchedule, nextRun } from '../shared/schedule';

export type AutomationInput = Omit<Automation, 'id' | 'createdAt' | 'nextRunAt'> & { id?: string };

export interface AutomationDeps {
  /** 给这次运行开一个新对话（place 是 worktree 时先建 worktree）；标题、模式等由这里定 */
  newConversation: (a: Automation, run: { id: string; title: string }) => Promise<ConversationMeta>;
  /** 把“要做什么”发进对话（界面上显示成一条用户消息） */
  send: (convId: string, text: string) => Promise<void>;
  /** 对话里还有没回答的审批或提问 */
  pendingCount: (convId: string) => number;
  /** 这个对话派给员工的活还有没做完的 */
  activeTasks: (convId: string) => number;
  projectExists: (projectPath: string) => boolean;
  /** 能不能在这个项目里开 worktree：能返回 null，不能返回原因 */
  worktreeCheck: (projectPath: string) => Promise<string | null>;
  /** 删掉对话（worktree 里的改动先存到分支上） */
  deleteConversation: (convId: string) => Promise<void>;
  emit: (ev: ConvEvent) => void;
  /** 系统通知（窗口不在前台时）；点了打开这个对话 */
  notify: (title: string, body: string, convId: string) => void;
  log: (line: string) => void;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (t: number) => { const d = new Date(t); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const MAX_RUNS = 300;

export class AutomationManager {
  private automations: Automation[] = [];
  private runs: AutomationRun[] = [];
  private file: string;
  private timer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string, private deps: AutomationDeps, private tickMs = 30_000) {
    this.file = path.join(dataDir, 'claudex-automations.json');
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<AutomationState>;
      this.automations = saved.automations ?? [];
      this.runs = saved.runs ?? [];
    } catch {
      // 第一次用
    }
    // 上次关 App 时还在跑的：进程已经没了（对话还在，可以打开接着做）
    for (const r of this.runs) {
      if (r.status === 'running' || r.status === 'waiting') Object.assign(r, { status: 'failed', endedAt: Date.now(), read: false, summary: 'Claudex 关闭时这次运行还没做完（对话还在，可以打开让 Claude 接着做）' });
    }
    for (const a of this.automations) if (a.enabled && !a.nextRunAt) a.nextRunAt = nextRun(a.schedule, Date.now()) ?? undefined;
  }

  /** 开始按计划跑（App 启动后调用）；马上检查一次，补跑 App 关着时错过的 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    setTimeout(() => this.tick(), 3000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  state(): AutomationState {
    return { automations: this.automations.map(a => ({ ...a })), runs: this.runs.map(r => ({ ...r })) };
  }

  private changed(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 300);
    this.deps.emit({ kind: 'automation', state: this.state() });
  }

  saveNow(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify({ automations: this.automations, runs: this.runs.slice(-MAX_RUNS) }, null, 2));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (e) {
      this.deps.log(`保存自动化失败：${e instanceof Error ? e.message : e}`);
    }
  }

  // ---------------- 增删改 ----------------

  async save(input: AutomationInput): Promise<AutomationState> {
    const name = input.name.trim();
    const prompt = input.prompt.trim();
    if (!name) throw new Error('名称不能为空');
    if (!prompt) throw new Error('要 Claude 做什么不能为空');
    if (!this.deps.projectExists(input.projectPath)) throw new Error('项目不在 Claudex 里了');
    const bad = checkSchedule(input.schedule);
    if (bad) throw new Error(bad);
    if (input.place === 'worktree') {
      const why = await this.deps.worktreeCheck(input.projectPath);
      if (why) throw new Error(`${why}。也可以选“本地”，直接在项目文件夹里跑`);
    }
    const old = input.id ? this.automations.find(a => a.id === input.id) : undefined;
    if (input.id && !old) throw new Error('找不到这个自动化');
    const a: Automation = {
      id: old?.id ?? randomUUID(), createdAt: old?.createdAt ?? Date.now(),
      name, prompt, projectPath: input.projectPath, schedule: { ...input.schedule }, place: input.place,
      mode: input.mode, model: input.model || undefined, effort: input.effort || undefined, enabled: input.enabled
    };
    a.nextRunAt = a.enabled ? nextRun(a.schedule, Date.now()) ?? undefined : undefined;
    if (old) Object.assign(old, a, { nextRunAt: a.nextRunAt });
    else this.automations.push(a);
    this.deps.log(`${old ? '修改' : '新建'}自动化「${a.name}」`);
    this.changed();
    return this.state();
  }

  delete(id: string): AutomationState {
    this.automations = this.automations.filter(a => a.id !== id);
    this.changed();
    return this.state();
  }

  setEnabled(id: string, enabled: boolean): AutomationState {
    const a = this.automations.find(x => x.id === id);
    if (!a) throw new Error('找不到这个自动化');
    a.enabled = enabled;
    a.nextRunAt = enabled ? nextRun(a.schedule, Date.now()) ?? undefined : undefined;
    this.changed();
    return this.state();
  }

  markRead(runId: string): AutomationState {
    const r = this.runs.find(x => x.id === runId);
    if (r && !r.read) { r.read = true; this.changed(); }
    return this.state();
  }

  async deleteRun(runId: string): Promise<AutomationState> {
    const r = this.runs.find(x => x.id === runId);
    if (!r) return this.state();
    if (r.status === 'running') throw new Error('这次运行还在跑，先停止再删除');
    await this.deps.deleteConversation(r.convId).catch(e => this.deps.log(`删除运行的对话失败：${e instanceof Error ? e.message : e}`));
    this.runs = this.runs.filter(x => x.id !== runId);
    this.changed();
    return this.state();
  }

  /** 对话被删了（从对话里删的）：运行记录也去掉 */
  forgetConversation(convId: string): void {
    const n = this.runs.length;
    this.runs = this.runs.filter(r => r.convId !== convId);
    if (this.runs.length !== n) this.changed();
  }

  // ---------------- 运行 ----------------

  /** 定时检查：到点的跑一次，并算出下一次 */
  tick(now = Date.now()): void {
    for (const a of this.automations) {
      if (!a.enabled || !a.nextRunAt || a.nextRunAt > now) continue;
      // 错过很久（App 当时没开）就算补跑；不管错过几次只补一次
      const trigger = now - a.nextRunAt > this.tickMs * 3 ? 'catchup' : 'schedule';
      a.nextRunAt = nextRun(a.schedule, now) ?? undefined;
      this.changed();
      void this.run(a.id, trigger).catch(e => this.deps.log(`自动化「${a.name}」没有跑起来：${e instanceof Error ? e.message : e}`));
    }
  }

  /** 跑一次。同一个自动化上一次还没跑完时：按计划的跳过，手动的报错 */
  async run(id: string, trigger: AutomationRun['trigger'] = 'manual'): Promise<AutomationRun> {
    const a = this.automations.find(x => x.id === id);
    if (!a) throw new Error('找不到这个自动化');
    const busy = this.runs.find(r => r.automationId === id && (r.status === 'running' || r.status === 'waiting'));
    if (busy) {
      if (trigger === 'manual') throw new Error(`上一次（${stamp(busy.startedAt)}）还没跑完，先在审查队列里处理它`);
      this.deps.log(`自动化「${a.name}」上一次还没跑完，这次跳过`);
      return busy;
    }
    const startedAt = Date.now();
    const r: AutomationRun = { id: randomUUID(), automationId: a.id, name: a.name, projectPath: a.projectPath, convId: '', trigger, status: 'running', startedAt, read: false };
    this.runs.push(r);
    this.changed();
    this.deps.log(`自动化「${a.name}」开始运行（${trigger === 'manual' ? '手动' : trigger === 'catchup' ? '补跑' : '按计划'}）`);
    try {
      if (!this.deps.projectExists(a.projectPath)) throw new Error('项目不在 Claudex 里了');
      const meta = await this.deps.newConversation(a, { id: r.id, title: `${a.name} · ${stamp(startedAt)}` });
      r.convId = meta.id;
      this.changed();
      await this.deps.send(meta.id, a.prompt);
    } catch (e) {
      this.finish(r, 'failed', `没有跑起来：${e instanceof Error ? e.message : e}`);
    }
    return { ...r };
  }

  private runOf(convId: string): AutomationRun | undefined {
    if (!convId) return undefined;
    for (let i = this.runs.length - 1; i >= 0; i--) if (this.runs[i].convId === convId) return this.runs[i];
    return undefined;
  }

  private finish(r: AutomationRun, status: 'done' | 'failed', summary?: string): void {
    const was = r.status;
    Object.assign(r, { status, endedAt: Date.now(), read: false, ...(summary !== undefined ? { summary } : {}) });
    this.changed();
    if (was !== status) {
      this.deps.log(`自动化「${r.name}」${status === 'done' ? '跑完了' : '没跑完'}`);
      if (r.convId) this.deps.notify(`自动化「${r.name}」${status === 'done' ? '跑完了' : '没跑完'}`, clip(r.summary ?? '', 120) || '打开审查队列看看', r.convId);
    }
  }

  private setWaiting(r: AutomationRun, what: string): void {
    if (r.status === 'waiting') return;
    Object.assign(r, { status: 'waiting', read: false });
    this.changed();
    this.deps.notify(`自动化「${r.name}」暂停了`, `${what}，需要你处理`, r.convId);
  }

  /** 用户在对话里回答了审批：没有别的待回答的就接着跑 */
  onRespond(convId: string): void {
    const r = this.runOf(convId);
    if (r?.status === 'waiting' && this.deps.pendingCount(convId) === 0) {
      r.status = 'running';
      this.changed();
    }
  }

  onConvEvent(ev: ConvEvent): void {
    if (!('convId' in ev)) return;
    const r = this.runOf(ev.convId);
    if (!r) return;
    if (ev.kind === 'permission') {
      const what = ev.request.toolName === 'AskUserQuestion' ? 'Claude 有问题要问你' : ev.request.toolName === 'ExitPlanMode' ? 'Claude 写好了计划，等你批准' : `Claude 想使用 ${ev.request.displayName ?? ev.request.toolName}`;
      this.setWaiting(r, what);
    } else if (ev.kind === 'status') {
      if (ev.status === 'error') this.finish(r, 'failed', `Claude Code 进程出错了：${ev.error ?? ''}`);
      else if (ev.status === 'running' && (r.status === 'done' || r.status === 'failed')) {
        // 用户打开接着聊了，或者员工交回的结果让负责人又开始了一轮
        r.status = 'running';
        r.endedAt = undefined;
        this.changed();
      }
    } else if (ev.kind === 'sdk' && ev.msg.type === 'result' && !(ev.msg as { parent_tool_use_id?: string }).parent_tool_use_id) {
      const m = ev.msg as { subtype?: string; is_error?: boolean; result?: string; errors?: string[] };
      const okRun = m.subtype === 'success' && !m.is_error;
      const text = okRun ? String(m.result ?? '').trim() : `没有正常完成（${m.subtype}）：${(m.errors ?? []).join('；') || m.result || ''}`;
      r.summary = clip(text, 600) || r.summary;
      if (this.deps.pendingCount(ev.convId) > 0) { this.setWaiting(r, '有操作等你审批'); return; }
      // 派给员工的活还没回来：等结果回来负责人汇总完才算跑完
      if (okRun && this.deps.activeTasks(ev.convId) > 0) { this.changed(); return; }
      this.finish(r, okRun ? 'done' : 'failed');
    }
  }
}
