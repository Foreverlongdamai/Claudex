// 团队：主对话是负责人（CEO），和用户沟通；员工是项目里的专职 Claude，各有档案（角色、能力、记忆）。
// - 档案：项目里的 .claude/agents/<编号>.md（Claude Code 子代理格式），长期记忆在 .claude/agent-memory/<编号>/，都是项目资产
// - 派活：负责人用 assign_task 派活，Claudex 给员工开一个新对话去做（返工就回到原来那个任务的对话），马上返回，不等
// - 结果：员工这一轮做完，汇报自动发回派活的对话（正在回复就排在后面）
// - 员工之间：handoff_task 把活转交给同事接着做（最后的结果交回最初派活的对话）；ask_colleague 请同事做一部分，
//   同事的结果回到这个员工的对话里，他接着做，等请同事帮忙的部分都回来了再汇报。交接不用负责人同意，派活的对话里会收到通知
// - 权限：员工一律完全访问（bypassPermissions）、全部工具，档案里不设工具和权限限制（用户决定）；保底黑名单照样拦截高危命令
// - 项目里每个主对话都能看所有员工、给任何员工派活、改任何员工的档案（招人和改档案先弹卡片给用户确认）
// - 员工的 Skills：档案里记“能用哪些”（Skill 本身在全局和项目里）；员工可以自己改这份清单（直接生效，留一条记录）
import { tool, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { convCwd, wrapResult, wrapTask } from '../shared/conv';
import { EMPLOYEE_ID, parseProfile, serializeProfile, toAgentDefinition, type EmployeeProfile } from '../shared/profile';
import type { ConvEvent, ConversationMeta, TeamTask } from '../shared/types';
import type { Store } from './store';

export interface TeamDeps {
  store: Store;
  /** 替用户往某个对话里发一条消息（会显示在界面上） */
  send: (convId: string, text: string) => Promise<void>;
  emit: (ev: ConvEvent) => void;
  env: (projectPath: string) => Record<string, string | undefined>;
  isBusy: (convId: string) => boolean;
  /** 项目里能用的 Skills（全局、项目、插件） */
  listSkills: (projectPath: string) => Promise<Array<{ name: string; description: string }>>;
  /** 停止某个对话正在做的事 */
  interrupt: (convId: string) => Promise<void>;
  /** 这些对话下一条消息起重启进程（档案改了） */
  markStale: (convIds: string[]) => void;
  /** 在对话里弹卡片请用户确认（招人、改档案；不受权限模式影响） */
  confirm: (convId: string, toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>;
  log: (line: string) => void;
}

const agentsDir = (projectPath: string) => path.join(projectPath, '.claude', 'agents');
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** 员工一律完全访问（用户决定：直接给员工完整的权限，不做各种限制；保底黑名单照样拦截） */
export const EMPLOYEE_MODE = 'bypassPermissions' as const;
/** 交接链最多几层（请同事帮忙一层算一层，转交也算） */
const MAX_DEPTH = 4;

/** 招人、改档案的工具参数（也是确认卡片里能改的内容） */
const profileShape = {
  displayName: z.string().describe('显示的名字，比如“小李”'),
  description: z.string().describe('一句话说清楚他负责什么（以后挑人就看这句）'),
  prompt: z.string().describe('角色提示词：身份、职责、工作方法、质量标准、汇报格式。写具体，像给新同事的岗位说明'),
  model: z.string().optional().describe('opus / sonnet / haiku；简单的活用便宜快的模型'),
  effort: z.enum(EFFORTS).optional().describe('思考强度'),
  skills: z.array(z.string()).optional().describe('他能用哪些 Skills（从 list_skills 列出的现有 Skill 里挑名字）；不填表示全部都能用。只选岗位用得上的')
};

const STATUS_TEXT: Record<TeamTask['status'], string> = { running: '在做', waiting: '等同事', handed: '已转交', done: '已交回', failed: '没做完' };

export class TeamManager {
  private tasks: TeamTask[] = [];
  private seq = 0;
  private file: string;
  private saveTimer: NodeJS.Timeout | null = null;
  /** 员工对话里排着的回合：每发一条消息记一项（任务编号，或者 null 表示用户直接发的），一轮结束时取出第一项 */
  private turns = new Map<string, Array<string | null>>();
  /** 用户在看板上停掉的任务（这一轮结束时结果写“用户停止了”，不显示 SDK 的诊断信息） */
  private stopped = new Set<string>();

  constructor(dataDir: string, private deps: TeamDeps) {
    this.file = path.join(dataDir, 'claudex-team.json');
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.tasks = saved.tasks ?? [];
      this.seq = saved.seq ?? 0;
      // 上次关 App 时还在做的任务，进程已经没了
      for (const t of this.tasks) if (t.status === 'running' || t.status === 'waiting') Object.assign(t, { status: 'failed', result: 'Claudex 关闭时这个任务还没做完', endedAt: Date.now() });
    } catch {
      // 第一次用
    }
  }

  private save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 300);
  }

  saveNow(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    try {
      fs.writeFileSync(this.file + '.tmp', JSON.stringify({ seq: this.seq, tasks: this.tasks.slice(-500) }));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (e) {
      this.deps.log(`保存任务记录失败：${e instanceof Error ? e.message : e}`);
    }
  }

  // ---------------- 档案 ----------------

  listProfiles(projectPath: string): EmployeeProfile[] {
    const dir = agentsDir(projectPath);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        try { return parseProfile(f.slice(0, -3), fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; }
      })
      .filter((p): p is EmployeeProfile => !!p)
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh'));
  }

  /** 按编号或名字找员工 */
  findProfile(projectPath: string, who: string): EmployeeProfile | undefined {
    const all = this.listProfiles(projectPath);
    const q = who.trim();
    return all.find(p => p.id === q) ?? all.find(p => p.displayName === q) ?? all.find(p => p.id.toLowerCase() === q.toLowerCase());
  }

  saveProfile(projectPath: string, p: EmployeeProfile, isNew: boolean): void {
    if (!EMPLOYEE_ID.test(p.id)) throw new Error(`员工编号「${p.id}」不合法：只能用小写英文字母、数字和 -，以字母开头`);
    if (!p.displayName.trim()) throw new Error('名字不能为空');
    if (!p.prompt.trim()) throw new Error('角色提示词不能为空');
    const file = path.join(agentsDir(projectPath), `${p.id}.md`);
    if (isNew && fs.existsSync(file)) throw new Error(`已经有编号是「${p.id}」的员工了`);
    if (!isNew && !fs.existsSync(file)) throw new Error(`找不到员工「${p.id}」`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serializeProfile(p));
    // 他正在进行的对话下一条消息起按新档案重启
    if (!isNew) this.deps.markStale(this.deps.store.state.conversations.filter(c => c.employee?.id === p.id && samePath(c.projectPath, projectPath)).map(c => c.id));
    this.deps.emit({ kind: 'team', projectPath });
  }

  deleteProfile(projectPath: string, id: string): void {
    fs.rmSync(path.join(agentsDir(projectPath), `${id}.md`), { force: true });
    this.deps.emit({ kind: 'team', projectPath });
  }

  /** 员工对话的 SDK 选项：整个会话以这个员工的身份运行（档案在 Claudex 这里读，worktree 里没提交的新档案也能用） */
  agentOptions(meta: ConversationMeta): { agent: string; agents: Record<string, ReturnType<typeof toAgentDefinition>>; skills?: string[] } | null {
    if (!meta.employee) return null;
    const p = this.findProfile(meta.projectPath, meta.employee.id);
    if (!p) return null;
    // Skills：档案里选了就只能用这几个（Skill 本身还在全局和项目里），用到时才加载；对他所有的对话都生效
    return { agent: p.id, agents: { [p.id]: toAgentDefinition(p) }, ...(p.skills?.length ? { skills: p.skills } : {}) };
  }

  // ---------------- 任务 ----------------

  listTasks(projectPath: string): TeamTask[] {
    return this.tasks.filter(t => samePath(t.projectPath, projectPath));
  }

  /** 这个对话派出去、还没交回的活（包括转交给别人的） */
  activeFrom(convId: string): number {
    return this.tasks.filter(t => t.fromConvId === convId && (t.status === 'running' || t.status === 'waiting')).length;
  }

  private task(id: string | undefined): TeamTask | undefined {
    return id ? this.tasks.find(t => t.id === String(id).replace(/^#/, '')) : undefined;
  }

  private emitTask(t: TeamTask): void {
    this.deps.emit({ kind: 'task', task: { ...t } });
  }

  private pushTurn(convId: string, taskId: string | null): void {
    const q = this.turns.get(convId) ?? [];
    q.push(taskId);
    this.turns.set(convId, q);
  }

  /** 用户直接在员工的对话里发了一条消息（不是任务） */
  onUserSend(convId: string): void {
    if (this.deps.store.conversation(convId)?.employee) this.pushTurn(convId, null);
  }

  /** 这个员工对话现在正在做的任务（null：没在做任务，或者是用户直接在聊） */
  activeTask(convId: string): TeamTask | null {
    return this.task(this.turns.get(convId)?.[0] ?? undefined) ?? null;
  }

  /** 员工新开一个对话（派活，或者用户直接找他聊） */
  newEmployeeConversation(projectPath: string, p: EmployeeProfile, opts: { title?: string; workdir?: string; from?: ConversationMeta } = {}): ConversationMeta {
    const meta = this.deps.store.newConversation(projectPath);
    const next: ConversationMeta = {
      ...meta,
      title: opts.title ?? `和${p.displayName}的对话`,
      employee: { id: p.id },
      mode: EMPLOYEE_MODE,
      model: p.model && p.model !== 'inherit' ? p.model : opts.from?.model ?? meta.model,
      effort: p.effort ?? opts.from?.effort ?? meta.effort,
      ...(opts.workdir && !samePath(opts.workdir, projectPath) ? { workdir: opts.workdir } : {})
    };
    this.deps.store.updateConversation(next);
    this.deps.emit({ kind: 'meta', convId: next.id, meta: next });
    return next;
  }

  /** 开一个任务：新对话（或者回到 inConv 那个对话）里发过去，马上返回任务 */
  private async start(from: ConversationMeta, p: EmployeeProfile, args: { title: string; text: string; inConv?: ConversationMeta; extra?: Partial<TeamTask>; body?: string }): Promise<TeamTask> {
    const conv = args.inConv ?? this.newEmployeeConversation(from.projectPath, p, { title: args.title, workdir: convCwd(from), from });
    const fromName = from.employee ? this.findProfile(from.projectPath, from.employee.id)?.displayName ?? from.employee.id : from.title;
    const task: TeamTask = {
      id: String(++this.seq), projectPath: from.projectPath, employeeId: p.id, employeeName: p.displayName,
      convId: conv.id, fromConvId: from.id, fromKind: from.employee ? 'employee' : 'boss', fromName,
      title: args.title, text: args.text, status: 'running', createdAt: Date.now(), depth: 0, ...args.extra
    };
    this.tasks.push(task);
    this.save();
    this.pushTurn(conv.id, task.id);
    this.emitTask(task);
    this.deps.log(`任务 #${task.id}：${fromName} → ${p.displayName}（${p.id}）「${args.title}」`);
    try {
      await this.deps.send(conv.id, wrapTask({ id: task.id, from: fromName, title: args.title }, args.body ?? args.text));
    } catch (e) {
      this.finish(task, 'failed', `没发出去：${e instanceof Error ? e.message : e}`);
      throw e;
    }
    return task;
  }

  /** 负责人派活 */
  async assign(boss: ConversationMeta, args: { employee: string; title: string; task: string; continue_task?: string }): Promise<{ text: string; isError?: boolean }> {
    const p = this.findProfile(boss.projectPath, args.employee);
    if (!p) {
      const list = this.listProfiles(boss.projectPath).map(e => `${e.id}（${e.displayName}）`).join('、') || '还没有员工';
      return { text: `找不到员工「${args.employee}」。现有员工：${list}。没有合适的人可以先用 hire_employee 招一个。`, isError: true };
    }
    let inConv: ConversationMeta | undefined;
    if (args.continue_task) {
      const prev = this.task(args.continue_task);
      if (!prev) return { text: `找不到任务 #${args.continue_task}`, isError: true };
      inConv = this.deps.store.conversation(prev.convId);
      if (!inConv) return { text: `任务 #${prev.id} 的对话已经被删掉了，请派一个新任务`, isError: true };
    }
    try {
      const t = await this.start(boss, p, { title: args.title, text: args.task, inConv });
      const queued = (this.turns.get(t.convId)?.length ?? 0) > 1;
      return {
        text: `已派给「${p.displayName}」（${p.id}）：任务 #${t.id}「${args.title}」。` +
          (inConv ? `在原来那个任务的对话里接着做${queued ? '（他手上这件事做完就接着做）' : ''}。` : '他会在自己的新对话里做。') +
          '做完结果会自动作为一条消息发回这个对话，不用等，现在可以继续做别的事。'
      };
    } catch (e) {
      return { text: `派活失败：${e instanceof Error ? e.message : e}`, isError: true };
    }
  }

  /** 员工请同事帮忙做一部分：同事的结果回到这个员工的对话，他接着做 */
  private async askColleague(me: ConversationMeta, args: { colleague: string; title: string; task: string }): Promise<{ text: string; isError?: boolean }> {
    const current = this.activeTask(me.id);
    if (!current) return { text: '只有在做负责人派的任务时才能请同事帮忙。', isError: true };
    const p = this.findProfile(me.projectPath, args.colleague);
    if (!p) return { text: `找不到同事「${args.colleague}」，先用 list_colleagues 看看有谁。`, isError: true };
    if (p.id === me.employee?.id) return { text: '不能请自己帮忙。', isError: true };
    if ((current.depth ?? 0) + 1 > MAX_DEPTH) return { text: `交接已经太多层了（最多 ${MAX_DEPTH} 层），这部分请自己做，或者在汇报里说明需要谁来做。`, isError: true };
    try {
      const sub = await this.start(me, p, { title: args.title, text: args.task, extra: { parentId: current.id, depth: (current.depth ?? 0) + 1 } });
      current.waitingFor = [...(current.waitingFor ?? []), sub.id];
      this.save();
      this.emitTask(current);
      this.notifyChain(current, `${current.employeeName} 请 ${p.displayName} 帮忙做“${args.title}”（#${sub.id}），这是 #${current.id} 的一部分`);
      return {
        text: `已请「${p.displayName}」帮忙：任务 #${sub.id}「${args.title}」。他做完，结果会自动发回这个对话，你再接着做。` +
          '现在可以先做不依赖他的部分；需要他的结果才能继续时，就结束这一轮（不用汇报），结果回来会自动接着做。等请同事帮忙的部分都回来了，再按格式汇报。'
      };
    } catch (e) {
      return { text: `没请到：${e instanceof Error ? e.message : e}`, isError: true };
    }
  }

  /** 员工把手上的活转交给同事接着做：最后的结果交回最初派活的对话 */
  private async handoff(me: ConversationMeta, args: { colleague: string; note: string; title?: string }): Promise<{ text: string; isError?: boolean }> {
    const current = this.activeTask(me.id);
    if (!current) return { text: '只有在做负责人派的任务时才能转交。', isError: true };
    if (current.handedTo) return { text: `这个任务已经转交给 #${current.handedTo} 了。`, isError: true };
    const p = this.findProfile(me.projectPath, args.colleague);
    if (!p) return { text: `找不到同事「${args.colleague}」，先用 list_colleagues 看看有谁。`, isError: true };
    if (p.id === me.employee?.id) return { text: '不能转交给自己。', isError: true };
    if ((current.depth ?? 0) + 1 > MAX_DEPTH) return { text: `交接已经太多层了（最多 ${MAX_DEPTH} 层），请自己做完，或者在汇报里说明需要谁来做。`, isError: true };
    const from = this.deps.store.conversation(current.fromConvId);
    if (!from) return { text: '派这个活的对话已经删掉了，没法转交。', isError: true };
    const title = args.title || current.title;
    const body = `【这个活由同事「${current.employeeName}」转交给你（原来是任务 #${current.id}）】\n\n原来的任务说明：\n${current.text ?? current.title}\n\n${current.employeeName} 的交接说明：\n${args.note}`;
    try {
      // 派活方不变：最后的结果交回最初派活的对话（负责人，或者请同事帮忙的那个员工）
      const next = await this.start(from, p, {
        title, text: current.text ?? title, body,
        extra: { handedFrom: current.id, parentId: current.parentId, depth: (current.depth ?? 0) + 1, fromName: current.fromName }
      });
      current.handedTo = next.id;
      // 请同事帮忙的那个员工在等的，换成接手的这个任务
      const parent = this.task(current.parentId);
      if (parent?.waitingFor) parent.waitingFor = parent.waitingFor.map(id => (id === current.id ? next.id : id));
      this.save();
      this.emitTask(current);
      this.notifyChain(current, `${current.employeeName} 把 #${current.id}“${current.title}”转交给了 ${p.displayName}（#${next.id}）`);
      return { text: `已转交给「${p.displayName}」：任务 #${next.id}。你的这部分到此为止，最后用一两句话说明你做了什么就行。` };
    } catch (e) {
      return { text: `没转交出去：${e instanceof Error ? e.message : e}`, isError: true };
    }
  }

  /** 交接时通知最初派活的那个主对话（只是界面上的一条提示，不打断负责人） */
  private notifyChain(t: TeamTask, text: string): void {
    let root: TeamTask | undefined = t;
    while (root?.parentId) root = this.task(root.parentId);
    const bossConv = root?.fromKind === 'employee' ? undefined : root?.fromConvId;
    if (bossConv) this.deps.emit({ kind: 'notice', convId: bossConv, tone: 'info', text });
  }

  private finish(t: TeamTask, status: TeamTask['status'], result: string): void {
    Object.assign(t, { status, result, endedAt: Date.now() });
    this.save();
    this.emitTask(t);
  }

  /** 对话进程的事件：员工对话一轮结束 → 对应的任务完成（或转交、或等同事），结果发回派活的对话 */
  onConvEvent(ev: ConvEvent): void {
    if (ev.kind === 'sdk' && ev.msg.type === 'result' && !(ev.msg as { parent_tool_use_id?: string }).parent_tool_use_id) {
      const q = this.turns.get(ev.convId);
      if (!q?.length) return;
      const taskId = q.shift() ?? null;
      const t = this.task(taskId ?? undefined);
      if (!t) return;
      // 同一个任务后面还有排着的回合（同事的结果已经发进来了）：等最后一轮
      if (q.includes(t.id)) return;
      const m = ev.msg as { subtype?: string; is_error?: boolean; result?: string; errors?: string[] };
      const okRun = m.subtype === 'success' && !m.is_error && !this.stopped.has(t.id);
      const text = this.stopped.delete(t.id) ? '用户停止了这个任务'
        : okRun ? String(m.result ?? '').trim() || '（员工没有写汇报）' : `任务没有正常完成（${m.subtype}）：${(m.errors ?? []).join('；') || m.result || ''}`;
      if (okRun && t.handedTo) { this.finish(t, 'handed', text); return; }
      const pending = (t.waitingFor ?? []).filter(id => { const s = this.task(id)?.status; return s === 'running' || s === 'waiting'; });
      if (okRun && pending.length) {
        Object.assign(t, { status: 'waiting', result: text });
        this.save();
        this.emitTask(t);
        return;
      }
      this.finish(t, okRun ? 'done' : 'failed', text);
      void this.deliver(t);
    } else if (ev.kind === 'status' && ev.status === 'error') {
      // 员工的进程出错：排着的任务都算失败
      const q = this.turns.get(ev.convId);
      if (!q?.length) return;
      this.turns.delete(ev.convId);
      for (const id of new Set(q)) {
        const t = this.task(id ?? undefined);
        if (t && (t.status === 'running' || t.status === 'waiting')) { this.finish(t, 'failed', `员工的进程出错了：${ev.error ?? ''}`); void this.deliver(t); }
      }
    }
  }

  /** 结果交回派活的对话：负责人，或者请同事帮忙的那个员工（他接着做） */
  private async deliver(t: TeamTask): Promise<void> {
    const target = this.deps.store.conversation(t.fromConvId);
    if (!target) {
      this.deps.emit({ kind: 'notice', convId: t.convId, tone: 'info', text: '派这个活的对话已经删掉了，结果没有送回去' });
      return;
    }
    const chain: string[] = [];
    for (let x = this.task(t.handedFrom); x; x = this.task(x.handedFrom)) chain.unshift(`#${x.id} ${x.employeeName}`);
    const toEmployee = !!target.employee && !!t.parentId;
    if (toEmployee) {
      const parent = this.task(t.parentId);
      if (parent) {
        parent.waitingFor = (parent.waitingFor ?? []).filter(id => id !== t.id);
        if (parent.status === 'waiting') parent.status = 'running';
        this.save();
        this.emitTask(parent);
        this.pushTurn(target.id, parent.id); // 结果回来的这一轮算在他原来的任务里
      }
    }
    try {
      await this.deps.send(target.id, wrapResult({
        id: t.id, employee: t.employeeId, name: t.employeeName, status: t.status, title: t.title,
        chain: chain.length ? `${chain.join(' → ')} → #${t.id} ${t.employeeName}` : undefined, toEmployee
      }, t.result ?? ''));
    } catch (e) {
      this.deps.log(`任务 #${t.id} 的结果送回失败：${e instanceof Error ? e.message : e}`);
    }
  }

  /** 停止一个正在做的任务（让员工的对话停下来；这一轮结束时记为没做完，并告诉派活的对话） */
  async stopTask(id: string): Promise<void> {
    const t = this.task(id);
    if (!t || (t.status !== 'running' && t.status !== 'waiting')) return;
    this.stopped.add(t.id);
    if (this.deps.isBusy(t.convId)) await this.deps.interrupt(t.convId);
    else {
      // 没在跑（在等同事）：直接记为没做完
      this.turns.set(t.convId, (this.turns.get(t.convId) ?? []).filter(x => x !== t.id));
      this.stopped.delete(t.id);
      this.finish(t, 'failed', '用户停止了这个任务');
      void this.deliver(t);
    }
  }

  /** 对话删掉了：它排着的回合也不要了 */
  forget(convId: string): void {
    this.turns.delete(convId);
  }

  // ---------------- 系统提示 ----------------

  private teamList(projectPath: string, exceptId?: string): string {
    const team = this.listProfiles(projectPath).filter(p => p.id !== exceptId);
    return team.length ? team.map(p => `- ${p.id}（${p.displayName}）：${p.description}`).join('\n') : '（还没有员工）';
  }

  bossPrompt(meta: ConversationMeta): string {
    return [
      '# 你的团队（Claudex）',
      '你是这个项目的负责人（CEO）：和用户沟通需求、拆分任务，把活派给团队里的员工，再把员工交回的结果核对、整理好告诉用户。用户的每个请求都先想一想该谁做：',
      '- 团队里有负责这类活的员工：派给他，哪怕活很小。员工有自己的长期记忆和用户教过的规矩（比如格式、署名、习惯），你自己做就绕过了这些。',
      '- 能分工、能并行的活：拆开，同时派给合适的员工。',
      '- 没有负责这类活的员工：一次性的小事（回答问题、看一眼文件、查个东西）你自己做；以后还会反复出现的同类活，向用户提议招一个专职员工。',
      '- 和用户沟通需求、核对员工交回的结果、向用户汇报，是你自己的事。',
      '- 员工是这个项目的资产，项目里所有主对话共用。mcp__claudex__list_employees 看有哪些员工、在忙什么；mcp__claudex__get_employee 看某个员工的完整档案和最近的任务。',
      '- 派活用 mcp__claudex__assign_task：写清楚目标、范围（要改哪些文件、不能动哪些）、验收标准和需要的背景。派完马上返回，不用等；员工做完，结果会作为一条 <claudex-task-result> 消息自动发回这个对话。',
      '- 同一个员工可以同时接好几个活，每个活他会开一个新对话去做。同时派出去的活要互不冲突（不要让两个人改同一个文件）。返工或接着改，用 assign_task 的 continue_task 回到原来那个任务的对话。',
      '- 员工之间可以自己交接：转交给同事接着做，或者请同事帮忙做一部分。最后的结果仍然交回给你（结果里会写明交接链）。',
      '- 没有合适的员工就用 mcp__claudex__hire_employee 招一个；员工做得不对、要调整职责或规矩，用 mcp__claudex__update_employee 改档案。招人和改档案会先请用户确认。档案要写具体：身份、职责、工作方法、质量标准、汇报格式；按活的难度选模型；Skills 从 mcp__claudex__list_skills 里挑岗位用得上的。',
      '- 员工都是完全访问、全部工具（不用审批，只有保底黑名单拦截高危命令），档案里没有工具和权限的设置。有的员工读得多、写得少（比如专门查资料的），写进他的职责和角色提示词里就行，查到的东西他也能写进项目文件里保存。',
      '- 收到员工交回的结果：核对是否达到验收标准，必要时让他返工，然后向用户汇报。还在进行的任务用 mcp__claudex__list_tasks 查。',
      '',
      '现在的团队（以 list_employees 为准）：',
      this.teamList(meta.projectPath)
    ].join('\n');
  }

  employeePrompt(meta: ConversationMeta): string | null {
    if (!meta.employee) return null;
    const p = this.findProfile(meta.projectPath, meta.employee.id);
    const name = p?.displayName ?? meta.employee.id;
    return [
      '# 团队协作（Claudex）',
      `你是这个项目团队里的员工「${name}」。项目负责人（主对话）或同事会把任务派给你，任务消息用 <claudex-task> 包着。`,
      '- 只做任务范围内的事。信息不够时按最合理的假设去做，并在汇报里说明假设；不要向用户提问。',
      '- 可能有其他员工同时在干活，不要改任务范围以外的文件。',
      '- 活更适合同事做：用 mcp__claudex__handoff_task 转交给他接着做，交接说明里写清楚你做到哪了、他要接着做什么；转交后你的部分就结束了。',
      '- 需要同事做其中一部分：用 mcp__claudex__ask_colleague 请他帮忙，他的结果会自动发回这个对话，你接着做；需要他的结果才能继续时，先结束这一轮（不用汇报），结果回来会自动接着做。',
      '- 同事有谁用 mcp__claudex__list_colleagues 查；不要交给自己。',
      '- 任务做完，用下面的格式汇报（这段汇报会原样交给派活的人）：',
      '  ## 结果：一两句话说清楚做成了什么',
      '  ## 改动：改了、新建了哪些文件（没有就写“无”）',
      '  ## 说明：派活的人需要知道的事——假设、风险、没做完的部分',
      p?.memory ? '- 做完活，把以后还用得上的经验、约定记进你的长期记忆；用户直接找你、教你规矩时也记进去。' : '- 用户也可能直接找你聊天、给你布置事情，照常完成。',
      `- 你能用的 Skills：${p?.skills?.length ? p.skills.join('、') : '全部'}。要调整（用户让你改，或者活需要清单以外的 Skill）：先用 mcp__claudex__list_skills 看现有的 Skill，再用 mcp__claudex__update_my_skills 改，直接生效、不用请示，改完对你所有的对话都生效（这个对话下一条消息起）。`,
      '',
      '同事：',
      this.teamList(meta.projectPath, meta.employee.id)
    ].join('\n');
  }

  // ---------------- 给主对话、员工的工具 ----------------

  private skillsTool(projectPath: string) {
    return tool('list_skills', '列出这个项目能用的全部 Skills（全局、项目、插件里的）：名字和说明。员工档案里的 Skills 从这里面挑', { filter: z.string().optional().describe('只看名字或说明里有这个词的') }, async ({ filter }) => {
      try {
        const all = await this.deps.listSkills(projectPath);
        const q = (filter ?? '').toLowerCase();
        const list = q ? all.filter(s => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)) : all;
        return ok(list.length ? list.map(s => `- ${s.name}：${clip(s.description.replace(/\s+/g, ' '), 140)}`).join('\n') : '没有找到');
      } catch (e) {
        return fail(`列不出来：${e instanceof Error ? e.message : e}`);
      }
    });
  }

  /** 给主对话的团队工具（和登记项目环境的工具放在同一个 claudex 服务器里） */
  bossTools(boss: ConversationMeta) {
    const pp = boss.projectPath;
    const summary = (p: EmployeeProfile) => {
      const busy = this.listTasks(pp).filter(t => t.employeeId === p.id && (t.status === 'running' || t.status === 'waiting'));
      return { id: p.id, name: p.displayName, description: p.description, model: p.model ?? '跟主对话一样', skills: p.skills ?? '全部', runningTasks: busy.map(t => `#${t.id} ${t.title}（${STATUS_TEXT[t.status]}）`) };
    };
    return [
      tool('list_employees', '列出这个项目的全部员工：编号、名字、负责什么、模型、Skills、正在做的任务', {}, async () => {
        const all = this.listProfiles(pp);
        return ok(all.length ? JSON.stringify(all.map(summary), null, 2) : '还没有员工。用 hire_employee 招一个。');
      }),
      tool('get_employee', '看某个员工的完整档案（包括角色提示词）和最近的任务', { employee: z.string().describe('员工编号或名字') }, async ({ employee }) => {
        const p = this.findProfile(pp, employee);
        if (!p) return fail(`找不到员工「${employee}」`);
        const recent = this.listTasks(pp).filter(t => t.employeeId === p.id).slice(-10).map(t => ({ task: `#${t.id}`, title: t.title, status: STATUS_TEXT[t.status], result: t.result ? clip(t.result, 300) : undefined }));
        return ok(JSON.stringify({ ...p, recentTasks: recent }, null, 2));
      }),
      this.skillsTool(pp),
      tool('hire_employee', '招一个新员工：写好档案（会先请用户确认，用户可能会改）。招完就能用 assign_task 派活', {
        id: z.string().describe('英文编号：小写字母、数字、-，比如 translator、code-reviewer'),
        ...profileShape,
        memory: z.boolean().optional().describe('要不要长期记忆（默认要）')
      }, async input => {
        // 先弹档案卡片给用户确认（用户可能改了再同意）
        const d = await this.deps.confirm(boss.id, 'mcp__claudex__hire_employee', input as Record<string, unknown>);
        if (d.behavior !== 'allow') return fail(`用户没有同意录用：${d.message || '没有说原因'}`);
        const a = { ...input, ...(d.updatedInput ?? {}) } as typeof input;
        try {
          const p: EmployeeProfile = { id: a.id, displayName: a.displayName, description: a.description, prompt: a.prompt, model: a.model, effort: a.effort, skills: a.skills, memory: a.memory === false ? null : 'project' };
          this.saveProfile(pp, p, true);
          return ok(`已录用「${p.displayName}」（编号 ${p.id}），档案存在 .claude/agents/${p.id}.md。可以用 assign_task 给他派活了。`);
        } catch (e) {
          return fail(`没有录用：${e instanceof Error ? e.message : e}`);
        }
      }),
      tool('update_employee', '修改某个员工的档案（职责、规矩、模型、Skills……）：只写要改的字段（会先请用户确认）。改完对他所有的对话都生效', {
        employee: z.string().describe('员工编号或名字'),
        displayName: z.string().optional(),
        description: z.string().optional(),
        prompt: z.string().optional().describe('新的完整角色提示词（不是只写改动的部分）'),
        model: z.string().optional(),
        effort: z.enum(EFFORTS).optional(),
        skills: z.array(z.string()).optional()
      }, async input => {
        if (!this.findProfile(pp, input.employee)) return fail(`找不到员工「${input.employee}」`);
        const d = await this.deps.confirm(boss.id, 'mcp__claudex__update_employee', input as Record<string, unknown>);
        if (d.behavior !== 'allow') return fail(`用户没有同意修改：${d.message || '没有说原因'}`);
        const a = { ...input, ...(d.updatedInput ?? {}) } as typeof input;
        const p = this.findProfile(pp, a.employee);
        if (!p) return fail(`找不到员工「${a.employee}」`);
        const { employee: _who, ...changes } = a;
        const next: EmployeeProfile = { ...p, ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) };
        try {
          this.saveProfile(pp, next, false);
          return ok(`已更新「${next.displayName}」的档案，对他所有的对话都生效（正在进行的对话下一条消息起）。`);
        } catch (e) {
          return fail(`没有更新：${e instanceof Error ? e.message : e}`);
        }
      }),
      tool('assign_task', '把一个活派给员工。马上返回，不用等；员工做完，结果会自动作为一条消息发回这个对话', {
        employee: z.string().describe('员工编号或名字'),
        title: z.string().describe('简短的标题，10 个字左右'),
        task: z.string().describe('任务说明：目标、范围（要改哪些文件、不能动哪些）、验收标准、需要的背景。员工看不到你和用户的对话，背景要写进来'),
        continue_task: z.string().optional().describe('返工或接着做：填原来的任务编号（比如 12），回到那个任务的对话里继续')
      }, async a => {
        const r = await this.assign(boss, a);
        return r.isError ? fail(r.text) : ok(r.text);
      }),
      tool('list_tasks', '这个项目的任务（所有主对话派的、员工之间交接的）：编号、员工、标题、状态', { status: z.enum(['running', 'waiting', 'handed', 'done', 'failed', 'all']).optional() }, async ({ status }) => {
        const list = this.listTasks(pp).filter(t => !status || status === 'all' || t.status === status).slice(-30);
        return ok(list.length ? list.map(t => `#${t.id} ${t.employeeName}「${t.title}」${STATUS_TEXT[t.status]}${t.handedTo ? ` → #${t.handedTo}` : ''}${t.waitingFor?.length ? `（等 ${t.waitingFor.map(x => `#${x}`).join('、')}）` : ''}${t.fromKind === 'employee' ? `（${t.fromName} 请他帮忙）` : t.fromConvId === boss.id ? '' : '（别的主对话派的）'}`).join('\n') : '没有任务');
      }),
      tool('get_task', '看某个任务的详情和员工交回的结果', { task: z.string().describe('任务编号') }, async ({ task }) => {
        const t = this.task(task);
        return t ? ok(JSON.stringify(t, null, 2)) : fail(`找不到任务 #${task}`);
      })
    ];
  }

  /** 给员工的工具：同事、交接、自己的 Skills */
  employeeTools(me: ConversationMeta) {
    const pp = me.projectPath;
    return [
      tool('list_colleagues', '列出同事：编号、名字、负责什么、正在做几个活', {}, async () => {
        const all = this.listProfiles(pp).filter(p => p.id !== me.employee?.id);
        if (!all.length) return ok('没有同事。');
        return ok(all.map(p => {
          const busy = this.listTasks(pp).filter(t => t.employeeId === p.id && (t.status === 'running' || t.status === 'waiting')).length;
          return `- ${p.id}（${p.displayName}）：${p.description}${busy ? `，正在做 ${busy} 个活` : ''}`;
        }).join('\n'));
      }),
      tool('handoff_task', '把手上这个活转交给更合适的同事接着做（比如写完交给审查员审）。转交后你的部分就结束了，最后的结果由他交回派活的人', {
        colleague: z.string().describe('同事的编号或名字'),
        note: z.string().describe('交接说明：你做到哪了、改了哪些文件、他要接着做什么、验收标准'),
        title: z.string().optional().describe('新的标题（不填沿用原来的）')
      }, async a => {
        const r = await this.handoff(me, a);
        return r.isError ? fail(r.text) : ok(r.text);
      }),
      tool('ask_colleague', '请同事帮忙做这个活的一部分。他的结果会自动发回这个对话，你接着做，最后由你汇总汇报', {
        colleague: z.string().describe('同事的编号或名字'),
        title: z.string().describe('简短的标题'),
        task: z.string().describe('要他做的部分：目标、范围、验收标准、需要的背景（他看不到你的对话）')
      }, async a => {
        const r = await this.askColleague(me, a);
        return r.isError ? fail(r.text) : ok(r.text);
      }),
      this.skillsTool(pp),
      tool('update_my_skills', '改自己档案里“能用哪些 Skills”（用户让你调整，或者活需要清单以外的 Skill 时用；直接生效，不用请示）。改完对你所有的对话都生效', {
        skills: z.array(z.string()).describe('能用的 Skill 名字（完整的新清单，从 list_skills 里挑）；空数组表示全部都能用'),
        reason: z.string().describe('为什么这样选')
      }, async input => {
        const p = me.employee ? this.findProfile(pp, me.employee.id) : undefined;
        if (!p) return fail('找不到你的档案');
        const skills = [...new Set(input.skills.map(x => x.trim()).filter(Boolean))];
        try {
          this.saveProfile(pp, { ...p, skills: skills.length ? skills : undefined }, false);
          // 不用请示（用户要员工权限尽量大），只在他的对话里留一条记录
          this.deps.emit({ kind: 'notice', convId: me.id, tone: 'ok', text: `${p.displayName}把自己能用的 Skills 改成了：${skills.length ? skills.join('、') : '全部'}`, detail: input.reason });
          return ok(`已更新：你能用的 Skills 现在是 ${skills.length ? skills.join('、') : '全部'}。对你所有的对话都生效（这个对话下一条消息起）。`);
        } catch (e) {
          return fail(`没改成：${e instanceof Error ? e.message : e}`);
        }
      })
    ];
  }
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}
