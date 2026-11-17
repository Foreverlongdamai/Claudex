// 团队：主对话是老板（CEO），和用户沟通；员工是项目里的专职 Claude，各有档案（角色、能力、记忆）。
// - 档案：项目里的 .claude/agents/<编号>.md（Claude Code 子代理格式），长期记忆在 .claude/agent-memory/<编号>/，都是项目资产
// - 派活：老板用 assign_task 派活，Claudex 给员工开一个新对话去做（返工就回到原来那个任务的对话），马上返回，不等
// - 结果：员工这一轮做完，汇报自动发回派活的主对话（主对话正在回复就排在后面）
// - 审批：员工做任务时需要审批的操作，由“负责人”判断（一次性的 Claude，看着任务和请求决定），理由记在员工的对话里
// - 项目里每个主对话都能看所有员工、给任何员工派活、改任何员工的档案（招人和改档案先弹卡片给用户确认）
import { createSdkMcpServer, query, tool, type McpServerConfig, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { convCwd, wrapResult, wrapTask } from '../shared/conv';
import { EMPLOYEE_ID, isReadOnly, parseProfile, serializeProfile, toAgentDefinition, type EmployeeProfile } from '../shared/profile';
import type { ConvEvent, ConversationMeta, ModeId, PermissionRequest, TeamTask, Verdict } from '../shared/types';
import type { Store } from './store';

export interface TeamDeps {
  store: Store;
  /** 替用户往某个对话里发一条消息（会显示在界面上） */
  send: (convId: string, text: string) => Promise<void>;
  emit: (ev: ConvEvent) => void;
  env: (projectPath: string) => Record<string, string | undefined>;
  isBusy: (convId: string) => boolean;
  log: (line: string) => void;
}

const agentsDir = (projectPath: string) => path.join(projectPath, '.claude', 'agents');
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
const MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** 招人、改档案的工具参数（也是确认卡片里能改的内容） */
const profileShape = {
  displayName: z.string().describe('显示的名字，比如“小李”'),
  description: z.string().describe('一句话说清楚他负责什么（以后挑人就看这句）'),
  prompt: z.string().describe('角色提示词：身份、职责、工作方法、质量标准、汇报格式。写具体，像给新同事的岗位说明'),
  tools: z.array(z.string()).optional().describe('能用的工具，比如 ["Read","Grep","Glob"] 是只读；不填表示全部工具'),
  model: z.string().optional().describe('opus / sonnet / haiku；简单的活用便宜快的模型'),
  effort: z.enum(EFFORTS).optional().describe('思考强度'),
  permissionMode: z.enum(MODES).optional().describe('权限：default 每次问、acceptEdits 改文件不问（推荐给写代码的）'),
  skills: z.array(z.string()).optional().describe('预装的 Skills 名字')
};

export class TeamManager {
  private tasks: TeamTask[] = [];
  private seq = 0;
  private file: string;
  private saveTimer: NodeJS.Timeout | null = null;
  /** 员工对话里排着的回合：每发一条消息记一项（任务编号，或者 null 表示用户直接发的），一轮结束时取出第一项 */
  private turns = new Map<string, Array<string | null>>();
  /** 负责人审批过的操作 */
  private judged: Array<{ convId: string; toolUseId: string } & Verdict> = [];

  constructor(dataDir: string, private deps: TeamDeps) {
    this.file = path.join(dataDir, 'claudex-team.json');
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.tasks = saved.tasks ?? [];
      this.seq = saved.seq ?? 0;
      this.judged = saved.judged ?? [];
      // 上次关 App 时还在做的任务，进程已经没了
      for (const t of this.tasks) if (t.status === 'running') Object.assign(t, { status: 'failed', result: 'Claudex 关闭时这个任务还没做完', endedAt: Date.now() });
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
      fs.writeFileSync(this.file + '.tmp', JSON.stringify({ seq: this.seq, tasks: this.tasks.slice(-500), judged: this.judged.slice(-2000) }));
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
    this.deps.emit({ kind: 'team', projectPath });
  }

  deleteProfile(projectPath: string, id: string): void {
    fs.rmSync(path.join(agentsDir(projectPath), `${id}.md`), { force: true });
    this.deps.emit({ kind: 'team', projectPath });
  }

  /** 员工对话的 SDK 选项：整个会话以这个员工的身份运行（档案在 Claudex 这里读，worktree 里没提交的新档案也能用） */
  agentOptions(meta: ConversationMeta): { agent: string; agents: Record<string, ReturnType<typeof toAgentDefinition>> } | null {
    if (!meta.employee) return null;
    const p = this.findProfile(meta.projectPath, meta.employee.id);
    return p ? { agent: p.id, agents: { [p.id]: toAgentDefinition(p) } } : null;
  }

  /** 只读的员工（档案里没有改文件的工具）：开了长期记忆时 Claude Code 会自动给写工具，只允许写他自己的记忆目录 */
  writeGuard(meta: ConversationMeta, toolName: string, input: Record<string, unknown>): string | null {
    if (!meta.employee || !['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)) return null;
    const p = this.findProfile(meta.projectPath, meta.employee.id);
    if (!p || !isReadOnly(p)) return null;
    const target = String(input.file_path ?? input.notebook_path ?? '');
    const norm = (s: string) => path.resolve(convCwd(meta), s).toLowerCase();
    const memDirs = [path.join(convCwd(meta), '.claude', 'agent-memory', p.id), path.join(convCwd(meta), '.claude', 'agent-memory-local', p.id)].map(d => d.toLowerCase());
    if (target && memDirs.some(d => norm(target).startsWith(d + path.sep))) return null;
    return `你的档案是只读的（不能修改项目文件），只能写你自己的长期记忆目录 .claude/agent-memory/${p.id}/。需要改文件的话，在汇报里写清楚要改什么，交给负责人安排。`;
  }

  // ---------------- 任务 ----------------

  listTasks(projectPath: string): TeamTask[] {
    const key = path.resolve(projectPath).toLowerCase();
    return this.tasks.filter(t => path.resolve(t.projectPath).toLowerCase() === key);
  }

  private emitTask(t: TeamTask): void {
    this.deps.emit({ kind: 'task', task: { ...t } });
  }

  /** 用户直接在员工的对话里发了一条消息（不是任务） */
  onUserSend(convId: string): void {
    const meta = this.deps.store.conversation(convId);
    if (!meta?.employee) return;
    const q = this.turns.get(convId) ?? [];
    q.push(null);
    this.turns.set(convId, q);
  }

  /** 这个员工对话现在正在做的任务（null：没在做任务，或者是用户直接在聊） */
  activeTask(convId: string): TeamTask | null {
    const head = this.turns.get(convId)?.[0];
    return head ? this.tasks.find(t => t.id === head) ?? null : null;
  }

  /** 员工新开一个对话（派活，或者用户直接找他聊） */
  newEmployeeConversation(projectPath: string, p: EmployeeProfile, opts: { title?: string; workdir?: string; boss?: ConversationMeta } = {}): ConversationMeta {
    const meta = this.deps.store.newConversation(projectPath);
    const mode: ModeId = p.permissionMode ?? 'default';
    const next: ConversationMeta = {
      ...meta,
      title: opts.title ?? `和${p.displayName}的对话`,
      employee: { id: p.id },
      mode,
      model: p.model && p.model !== 'inherit' ? p.model : opts.boss?.model ?? meta.model,
      effort: p.effort ?? opts.boss?.effort ?? meta.effort,
      ...(opts.workdir && path.resolve(opts.workdir).toLowerCase() !== path.resolve(projectPath).toLowerCase() ? { workdir: opts.workdir } : {})
    };
    this.deps.store.updateConversation(next);
    this.deps.emit({ kind: 'meta', convId: next.id, meta: next });
    return next;
  }

  /** 派活：开新对话（或者回到原来那个任务的对话）发过去，马上返回 */
  async assign(boss: ConversationMeta, args: { employee: string; title: string; task: string; continue_task?: string }): Promise<{ text: string; isError?: boolean }> {
    const p = this.findProfile(boss.projectPath, args.employee);
    if (!p) {
      const list = this.listProfiles(boss.projectPath).map(e => `${e.id}（${e.displayName}）`).join('、') || '还没有员工';
      return { text: `找不到员工「${args.employee}」。现有员工：${list}。没有合适的人可以先用 hire_employee 招一个。`, isError: true };
    }
    let conv: ConversationMeta | undefined;
    if (args.continue_task) {
      const prev = this.tasks.find(t => t.id === String(args.continue_task).replace(/^#/, ''));
      if (!prev) return { text: `找不到任务 #${args.continue_task}`, isError: true };
      conv = this.deps.store.conversation(prev.convId);
      if (!conv) return { text: `任务 #${prev.id} 的对话已经被删掉了，请派一个新任务`, isError: true };
    }
    conv ??= this.newEmployeeConversation(boss.projectPath, p, { title: args.title, workdir: convCwd(boss), boss });
    const task: TeamTask = {
      id: String(++this.seq), projectPath: boss.projectPath, employeeId: p.id, employeeName: p.displayName,
      convId: conv.id, fromConvId: boss.id, title: args.title, status: 'running', createdAt: Date.now()
    };
    this.tasks.push(task);
    this.save();
    const q = this.turns.get(conv.id) ?? [];
    q.push(task.id);
    this.turns.set(conv.id, q);
    this.emitTask(task);
    this.deps.log(`派活 #${task.id}：${boss.title} → ${p.displayName}（${p.id}）「${args.title}」`);
    try {
      await this.deps.send(conv.id, wrapTask({ id: task.id, from: boss.title, title: args.title }, args.task));
    } catch (e) {
      this.finish(task, 'failed', `没发出去：${e instanceof Error ? e.message : e}`);
      return { text: `派活失败：${e instanceof Error ? e.message : e}`, isError: true };
    }
    const queued = (this.turns.get(conv.id)?.length ?? 0) > 1;
    return {
      text: `已派给「${p.displayName}」（${p.id}）：任务 #${task.id}「${args.title}」。` +
        (args.continue_task ? `在原来那个任务的对话里接着做${queued ? '（他手上这件事做完就接着做）' : ''}。` : '他会在自己的新对话里做。') +
        '做完结果会自动作为一条消息发回这个对话，不用等，现在可以继续做别的事。'
    };
  }

  private finish(t: TeamTask, status: 'done' | 'failed', result: string): void {
    Object.assign(t, { status, result, endedAt: Date.now() });
    this.save();
    this.emitTask(t);
  }

  /** 对话进程的事件：员工对话一轮结束 → 对应的任务完成，结果发回派活的主对话 */
  onConvEvent(ev: ConvEvent): void {
    if (ev.kind === 'sdk' && ev.msg.type === 'result' && !(ev.msg as { parent_tool_use_id?: string }).parent_tool_use_id) {
      const q = this.turns.get(ev.convId);
      if (!q?.length) return;
      const taskId = q.shift() ?? null;
      if (!taskId) return;
      const t = this.tasks.find(x => x.id === taskId);
      if (!t) return;
      const m = ev.msg as { subtype?: string; is_error?: boolean; result?: string; errors?: string[] };
      const okRun = m.subtype === 'success' && !m.is_error;
      const text = okRun ? String(m.result ?? '').trim() || '（员工没有写汇报）' : `任务没有正常完成（${m.subtype}）：${(m.errors ?? []).join('；') || m.result || ''}`;
      this.finish(t, okRun ? 'done' : 'failed', text);
      void this.deliver(t);
    } else if (ev.kind === 'status' && ev.status === 'error') {
      // 员工的进程出错：排着的任务都算失败
      const q = this.turns.get(ev.convId);
      if (!q?.length) return;
      this.turns.delete(ev.convId);
      for (const id of q) {
        const t = id ? this.tasks.find(x => x.id === id) : null;
        if (t && t.status === 'running') { this.finish(t, 'failed', `员工的进程出错了：${ev.error ?? ''}`); void this.deliver(t); }
      }
    }
  }

  private async deliver(t: TeamTask): Promise<void> {
    const boss = this.deps.store.conversation(t.fromConvId);
    if (!boss) {
      this.deps.emit({ kind: 'notice', convId: t.convId, tone: 'info', text: `派这个活的主对话已经删掉了，结果没有送回去` });
      return;
    }
    try {
      await this.deps.send(boss.id, wrapResult({ id: t.id, employee: t.employeeId, name: t.employeeName, status: t.status, title: t.title }, t.result ?? ''));
    } catch (e) {
      this.deps.log(`任务 #${t.id} 的结果送回失败：${e instanceof Error ? e.message : e}`);
    }
  }

  /** 对话删掉了：它排着的回合也不要了 */
  forget(convId: string): void {
    this.turns.delete(convId);
    this.judged = this.judged.filter(j => j.convId !== convId);
  }

  /** 某个员工对话里负责人审批过的操作（打开对话时显示） */
  judgedFor(convId: string): Record<string, Verdict> {
    return Object.fromEntries(this.judged.filter(j => j.convId === convId).map(j => [j.toolUseId, { allow: j.allow, reason: j.reason, what: j.what }]));
  }

  // ---------------- 负责人替用户审批 ----------------

  /**
   * 员工做任务时遇到需要审批的操作：交给负责人判断（一次性的 Claude，不带工具）。
   * 不是在做任务（用户直接在聊）时返回 null，照常问用户。
   */
  async approve(meta: ConversationMeta, req: PermissionRequest): Promise<PermissionResult | null> {
    const task = this.activeTask(meta.id);
    if (!task || !meta.employee) return null;
    const p = this.findProfile(meta.projectPath, meta.employee.id);
    const input = req.input;
    const what = req.toolName === 'Bash' || req.toolName === 'PowerShell' ? `运行命令：${String(input.command ?? '')}`
      : ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(req.toolName) ? `${req.toolName === 'Write' ? '写入' : '修改'}文件：${String(input.file_path ?? input.notebook_path ?? '')}`
        : req.toolName === 'WebFetch' ? `读取网页：${String(input.url ?? '')}`
          : `使用 ${req.toolName}：${clip(JSON.stringify(input), 600)}`;
    const prompt = [
      `你是这个软件项目（${meta.projectPath}）的负责人。你的员工「${p?.displayName ?? meta.employee.id}」（${p?.description ?? ''}）正在做你派的任务，现在他想执行一个需要批准的操作。请判断是否允许。`,
      '',
      `任务 #${task.id}「${task.title}」`,
      `他想${what}`,
      req.description ? `（他的说明：${req.description}）` : '',
      req.blockedPath ? `（涉及项目以外的路径：${req.blockedPath}）` : '',
      req.decisionReason ? `（Claude Code 要求审批的原因：${req.decisionReason}）` : '',
      '',
      '判断标准：完成这个任务确实需要；只影响项目文件夹里的东西；不删除重要数据、不泄露密钥、不推送代码或对外发布（任务明确要求的除外）、不改系统设置、不装全局软件。拿不准时拒绝，并说明他该怎么做。',
      '只回复一行：「允许：理由」或「拒绝：理由」。'
    ].filter(Boolean).join('\n');
    let line = '';
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 90_000);
    try {
      const q = query({
        prompt,
        options: {
          cwd: convCwd(meta), env: this.deps.env(meta.projectPath), model: 'sonnet', tools: [], maxTurns: 1, persistSession: false,
          permissionMode: 'default', strictMcpConfig: true, mcpServers: {}, abortController: abort,
          systemPrompt: '你是软件项目的负责人，负责审批员工的操作。回答简短。'
        }
      });
      for await (const m of q) if (m.type === 'result') line = m.subtype === 'success' ? String(m.result ?? '') : '';
    } catch (e) {
      this.deps.log(`负责人审批出错：${e instanceof Error ? e.message : e}`);
    } finally {
      clearTimeout(timer);
    }
    const first = line.trim().split('\n')[0] ?? '';
    const allow = /^允许/.test(first);
    const reason = first.replace(/^(允许|拒绝)[:：]?\s*/, '') || (line ? first : '负责人没有及时批复');
    // 记下来（员工的对话可能这时没人打开，之后打开也要能看到），显示在那一行活动记录上
    const verdict = { allow, reason, what: clip(what, 300) };
    if (req.toolUseId) {
      this.judged.push({ convId: meta.id, toolUseId: req.toolUseId, ...verdict });
      this.save();
      this.deps.emit({ kind: 'judged', convId: meta.id, toolUseId: req.toolUseId, verdict });
    } else {
      this.deps.emit({ kind: 'notice', convId: meta.id, tone: allow ? 'ok' : 'error', text: `负责人${allow ? '批准了' : '没有批准'}：${clip(what, 160)}`, detail: reason });
    }
    this.deps.log(`负责人审批 #${task.id} ${allow ? '允许' : '拒绝'}：${clip(what, 120)} —— ${reason}`);
    return allow
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: `负责人没有批准：${reason}。换一个不需要这个操作的办法；做不到就在汇报里说明。` };
  }

  // ---------------- 系统提示 ----------------

  bossPrompt(meta: ConversationMeta): string {
    const team = this.listProfiles(meta.projectPath);
    const list = team.length ? team.map(p => `- ${p.id}（${p.displayName}）：${p.description}${isReadOnly(p) ? '（只读）' : ''}`).join('\n') : '（还没有员工）';
    return [
      '# 你的团队（Claudex）',
      '你是这个项目的负责人（CEO）：和用户沟通需求、拆分任务，把能分工、能并行的活派给团队里的员工，再把员工交回的结果核对、整理好告诉用户。小事可以自己顺手做，但能分工、能并行的活优先派给员工。',
      '- 员工是这个项目的资产，项目里所有主对话共用。mcp__claudex__list_employees 看有哪些员工、在忙什么；mcp__claudex__get_employee 看某个员工的完整档案和最近的任务。',
      '- 派活用 mcp__claudex__assign_task：写清楚目标、范围（要改哪些文件、不能动哪些）、验收标准和需要的背景。派完马上返回，不用等；员工做完，结果会作为一条 <claudex-task-result> 消息自动发回这个对话。',
      '- 同一个员工可以同时接好几个活，每个活他会开一个新对话去做。同时派出去的活要互不冲突（不要让两个人改同一个文件）。返工或接着改，用 assign_task 的 continue_task 回到原来那个任务的对话。',
      '- 没有合适的员工就用 mcp__claudex__hire_employee 招一个；员工做得不对、要调整职责或规矩，用 mcp__claudex__update_employee 改档案。招人和改档案会先请用户确认。档案要写具体：身份、职责、工作方法、质量标准、汇报格式；只看不改的岗位只给读文件的工具；按活的难度选模型。',
      '- 员工做任务时遇到需要审批的操作，由你（负责人）判断，Claudex 会代你处理。',
      '- 收到员工交回的结果：核对是否达到验收标准，必要时让他返工，然后向用户汇报。还在进行的任务用 mcp__claudex__list_tasks 查。',
      '',
      '现在的团队（以 list_employees 为准）：',
      list
    ].join('\n');
  }

  employeePrompt(meta: ConversationMeta): string | null {
    if (!meta.employee) return null;
    const p = this.findProfile(meta.projectPath, meta.employee.id);
    const name = p?.displayName ?? meta.employee.id;
    return [
      '# 团队协作（Claudex）',
      `你是这个项目团队里的员工「${name}」。项目负责人（主对话）会把任务派给你，任务消息用 <claudex-task> 包着。`,
      '- 只做任务范围内的事。信息不够时按最合理的假设去做，并在汇报里说明假设；不要向用户提问。',
      '- 可能有其他员工同时在干活，不要改任务范围以外的文件。',
      '- 任务做完，用下面的格式汇报（这段汇报会原样交给负责人）：',
      '  ## 结果：一两句话说清楚做成了什么',
      '  ## 改动：改了、新建了哪些文件（没有就写“无”）',
      '  ## 说明：负责人需要知道的事——假设、风险、没做完的部分',
      p?.memory ? '- 做完活，把以后还用得上的经验、约定记进你的长期记忆；用户直接找你、教你规矩时也记进去。' : '- 用户也可能直接找你聊天、给你布置事情，照常完成。'
    ].join('\n');
  }

  // ---------------- 给主对话的工具 ----------------

  /** 给主对话的团队工具（和登记项目环境的工具放在同一个 claudex 服务器里） */
  bossTools(boss: ConversationMeta) {
    const pp = boss.projectPath;
    const summary = (p: EmployeeProfile) => {
      const running = this.listTasks(pp).filter(t => t.employeeId === p.id && t.status === 'running');
      return { id: p.id, name: p.displayName, description: p.description, model: p.model ?? '跟主对话一样', tools: p.tools ?? '全部', readOnly: isReadOnly(p), permissionMode: p.permissionMode ?? 'default', runningTasks: running.map(t => `#${t.id} ${t.title}`) };
    };
    return [
        tool('list_employees', '列出这个项目的全部员工：编号、名字、负责什么、模型、工具、正在做的任务', {}, async () => {
          const all = this.listProfiles(pp);
          return ok(all.length ? JSON.stringify(all.map(summary), null, 2) : '还没有员工。用 hire_employee 招一个。');
        }),
        tool('get_employee', '看某个员工的完整档案（包括角色提示词）和最近的任务', { employee: z.string().describe('员工编号或名字') }, async ({ employee }) => {
          const p = this.findProfile(pp, employee);
          if (!p) return fail(`找不到员工「${employee}」`);
          const recent = this.listTasks(pp).filter(t => t.employeeId === p.id).slice(-10).map(t => ({ task: `#${t.id}`, title: t.title, status: t.status, result: t.result ? clip(t.result, 300) : undefined }));
          return ok(JSON.stringify({ ...p, recentTasks: recent }, null, 2));
        }),
        tool('hire_employee', '招一个新员工：写好档案（会先请用户确认，用户可能会改）。招完就能用 assign_task 派活', {
          id: z.string().describe('英文编号：小写字母、数字、-，比如 translator、code-reviewer'),
          ...profileShape,
          memory: z.boolean().optional().describe('要不要长期记忆（默认要）')
        }, async a => {
          try {
            const p: EmployeeProfile = { id: a.id, displayName: a.displayName, description: a.description, prompt: a.prompt, tools: a.tools, model: a.model, effort: a.effort, permissionMode: a.permissionMode, skills: a.skills, memory: a.memory === false ? null : 'project' };
            this.saveProfile(pp, p, true);
            return ok(`已录用「${p.displayName}」（编号 ${p.id}），档案存在 .claude/agents/${p.id}.md。可以用 assign_task 给他派活了。`);
          } catch (e) {
            return fail(`没有录用：${e instanceof Error ? e.message : e}`);
          }
        }),
        tool('update_employee', '修改某个员工的档案（职责、规矩、模型、工具……）：只写要改的字段（会先请用户确认）。下一个新对话开始生效', {
          employee: z.string().describe('员工编号或名字'),
          displayName: z.string().optional(),
          description: z.string().optional(),
          prompt: z.string().optional().describe('新的完整角色提示词（不是只写改动的部分）'),
          tools: z.array(z.string()).optional(),
          model: z.string().optional(),
          effort: z.enum(EFFORTS).optional(),
          permissionMode: z.enum(MODES).optional(),
          skills: z.array(z.string()).optional()
        }, async a => {
          const p = this.findProfile(pp, a.employee);
          if (!p) return fail(`找不到员工「${a.employee}」`);
          const { employee: _who, ...changes } = a;
          const next: EmployeeProfile = { ...p, ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) };
          try {
            this.saveProfile(pp, next, false);
            return ok(`已更新「${next.displayName}」的档案。之后新开的对话按新档案工作。`);
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
        tool('list_tasks', '这个项目的任务（所有主对话派的）：编号、员工、标题、状态', { status: z.enum(['running', 'done', 'failed', 'all']).optional() }, async ({ status }) => {
          const list = this.listTasks(pp).filter(t => !status || status === 'all' || t.status === status).slice(-30);
          return ok(list.length ? list.map(t => `#${t.id} ${t.employeeName}「${t.title}」${t.status === 'running' ? '进行中' : t.status === 'done' ? '已完成' : '失败'}${t.fromConvId === boss.id ? '' : '（别的主对话派的）'}`).join('\n') : '没有任务');
        }),
        tool('get_task', '看某个任务的详情和员工交回的结果', { task: z.string().describe('任务编号') }, async ({ task }) => {
          const t = this.tasks.find(x => x.id === String(task).replace(/^#/, ''));
          return t ? ok(JSON.stringify(t, null, 2)) : fail(`找不到任务 #${task}`);
        })
    ];
  }
}

export type BossTools = ReturnType<TeamManager['bossTools']>;
export { createSdkMcpServer, tool };
export type { McpServerConfig };
