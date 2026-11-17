// 团队界面：员工档案表单（招人、改档案共用）、招人/改档案的确认卡片、派活记录、任务卡片、员工交回的结果卡片。
import { useMemo, useState } from 'react';
import type { EmployeeMode, EmployeeProfile, PermissionRequest } from '@shared/types';
import { EFFORTS, type Effort } from '@shared/types';
import { useStore } from '../store';
import type { Item } from '../timeline';
import { Icon } from './Icon';
import { Markdown } from './Markdown';

const READONLY_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];
const EFFORT_LABEL: Record<Effort, string> = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大' };
const MODE_LABEL: Record<EmployeeMode, string> = { default: '每次都问（交给负责人批）', acceptEdits: '改文件不问', plan: '只做计划', bypassPermissions: '完全访问（保底黑名单仍拦截）' };
const sameList = (a?: string[], b?: string[]) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export const blankProfile = (): EmployeeProfile => ({ id: '', displayName: '', description: '', prompt: '', memory: 'project', permissionMode: 'acceptEdits' });

// ---------------- 档案表单 ----------------

export function ProfileForm({ value, onChange, isNew }: { value: EmployeeProfile; onChange: (p: EmployeeProfile) => void; isNew: boolean }) {
  const set = (patch: Partial<EmployeeProfile>) => onChange({ ...value, ...patch });
  const toolsMode = !value.tools ? 'all' : sameList([...value.tools].sort(), [...READONLY_TOOLS].sort()) ? 'readonly' : 'custom';
  const models = ['', 'opus', 'sonnet', 'haiku'];
  return (
    <div className="pform" data-testid="profile-form">
      <div className="pf-row">
        <label>名字<input value={value.displayName} placeholder="小李" data-testid="pf-name" onChange={e => set({ displayName: e.target.value })} /></label>
        <label>编号<input value={value.id} placeholder="translator" disabled={!isNew} data-testid="pf-id" onChange={e => set({ id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} />
          <small>{isNew ? '小写英文、数字、-；也是档案文件名' : `.claude/agents/${value.id}.md`}</small></label>
      </div>
      <label>负责什么<input value={value.description} placeholder="一句话：老板按这个挑人" data-testid="pf-desc" onChange={e => set({ description: e.target.value })} /></label>
      <label>角色提示词<small>身份、职责、工作方法、质量标准、汇报格式。这是他最核心的“底层逻辑”</small>
        <textarea rows={8} value={value.prompt} data-testid="pf-prompt" onChange={e => set({ prompt: e.target.value })} /></label>
      <div className="pf-row">
        <label>模型
          <select value={value.model ?? ''} onChange={e => set({ model: e.target.value || undefined })}>
            {[...models, ...(value.model && !models.includes(value.model) ? [value.model] : [])].map(m => <option key={m} value={m}>{m || '跟主对话一样'}</option>)}
          </select></label>
        <label>思考强度
          <select value={value.effort ?? ''} onChange={e => set({ effort: (e.target.value || undefined) as Effort | undefined })}>
            <option value="">跟主对话一样</option>
            {EFFORTS.map(x => <option key={x} value={x}>{EFFORT_LABEL[x]}</option>)}
          </select></label>
        <label>权限
          <select value={value.permissionMode ?? 'default'} onChange={e => set({ permissionMode: e.target.value as EmployeeMode })}>
            {(Object.keys(MODE_LABEL) as EmployeeMode[]).map(m => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
          </select></label>
      </div>
      <div className="pf-row">
        <label>能用的工具
          <select value={toolsMode} data-testid="pf-tools" onChange={e => set({ tools: e.target.value === 'all' ? undefined : e.target.value === 'readonly' ? [...READONLY_TOOLS] : value.tools ?? ['Read', 'Grep', 'Glob', 'Edit', 'Write'] })}>
            <option value="all">全部（和主对话一样）</option>
            <option value="readonly">只读：读文件、搜索、查网页</option>
            <option value="custom">自定义</option>
          </select></label>
        {toolsMode === 'custom' && (
          <label className="grow">工具列表<input value={(value.tools ?? []).join(', ')} onChange={e => set({ tools: e.target.value.split(/[,，\s]+/).filter(Boolean) })} /></label>
        )}
      </div>
      <div className="pf-row">
        <label className="grow">预装的 Skills<input value={(value.skills ?? []).join(', ')} placeholder="可以不填，多个用逗号隔开" onChange={e => { const s = e.target.value.split(/[,，\s]+/).filter(Boolean); set({ skills: s.length ? s : undefined }); }} /></label>
        <label className="check"><input type="checkbox" checked={!!value.memory} onChange={e => set({ memory: e.target.checked ? 'project' : null })} />长期记忆<small>教过的规矩、积累的经验都记下来</small></label>
      </div>
    </div>
  );
}

// ---------------- 招人 / 改档案的确认卡片（主对话里） ----------------

/** 工具参数 → 档案 */
function fromHireInput(input: Record<string, unknown>): EmployeeProfile {
  const list = (v: unknown) => (Array.isArray(v) ? (v as string[]) : undefined);
  return {
    id: String(input.id ?? ''), displayName: String(input.displayName ?? ''), description: String(input.description ?? ''), prompt: String(input.prompt ?? ''),
    tools: list(input.tools), model: input.model ? String(input.model) : undefined, effort: input.effort as Effort | undefined,
    permissionMode: input.permissionMode as EmployeeMode | undefined, skills: list(input.skills), memory: input.memory === false ? null : 'project'
  };
}

const CHANGE_LABEL: Record<string, string> = { displayName: '名字', description: '负责什么', prompt: '角色提示词', tools: '工具', model: '模型', effort: '思考强度', permissionMode: '权限', skills: 'Skills' };

export function ProfileApproval({ convId, request }: { convId: string; request: PermissionRequest }) {
  const respond = useStore(s => s.respond);
  const projectPath = useStore(s => s.convs[convId]?.meta.projectPath ?? '');
  const team = useStore(s => s.team[projectPath] ?? []);
  const isHire = request.toolName === 'mcp__claudex__hire_employee';
  const input = request.input;
  const current = isHire ? null : team.find(p => p.id === input.employee || p.displayName === input.employee) ?? null;
  const initial = useMemo<EmployeeProfile>(() => {
    if (isHire) return fromHireInput(input);
    const base = current ?? { ...fromHireInput({}), id: String(input.employee ?? '') };
    const changes = Object.fromEntries(Object.entries(input).filter(([k, v]) => k !== 'employee' && v !== undefined));
    return { ...base, ...changes } as EmployeeProfile;
  }, [request.requestId, current?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [draft, setDraft] = useState<EmployeeProfile>(initial);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');
  const changed = isHire ? [] : Object.keys(input).filter(k => k !== 'employee' && CHANGE_LABEL[k]).map(k => CHANGE_LABEL[k]);
  const approve = () => {
    const common = { displayName: draft.displayName, description: draft.description, prompt: draft.prompt, tools: draft.tools, model: draft.model, effort: draft.effort, permissionMode: draft.permissionMode, skills: draft.skills };
    const updatedInput = isHire ? { id: draft.id, ...common, memory: !!draft.memory } : { employee: draft.id, ...common };
    void respond(convId, { requestId: request.requestId, behavior: 'allow', updatedInput }, isHire ? `录用了「${draft.displayName}」` : `同意修改「${draft.displayName}」的档案`);
  };
  const deny = () => void respond(convId, { requestId: request.requestId, behavior: 'deny', message: reason.trim() || '用户没有同意' }, reason);
  return (
    <div className="approval profile-card" data-testid="profile-approval">
      <div className="ap-title"><Icon name="users" />{isHire ? '负责人想招一个新员工' : `负责人想修改「${current?.displayName ?? input.employee}」的档案`}</div>
      {!isHire && changed.length > 0 && <div className="ap-meta">要改的：{changed.join('、')}</div>}
      {!isHire && !current && <div className="ap-meta">（找不到这个员工，同意也会失败）</div>}
      <p className="ap-meta">可以直接在下面改，再{isHire ? '录用' : '同意'}。</p>
      <ProfileForm value={draft} onChange={setDraft} isNew={isHire} />
      <div className="ap-actions">
        <button className="btn primary" data-testid="profile-approve" onClick={approve}>{isHire ? '录用' : '同意修改'}</button>
        <button className="btn ghost" onClick={() => setDenying(true)}>不同意…</button>
      </div>
      {denying && (
        <div className="deny-box">
          <input autoFocus value={reason} onChange={e => setReason(e.target.value)} placeholder="告诉负责人为什么（可选）"
            onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) deny(); }} />
          <button className="btn" onClick={deny}>不同意</button>
        </div>
      )}
    </div>
  );
}

// ---------------- 档案弹窗（侧栏“招人”、员工对话顶栏的“档案”） ----------------

export function EmployeeEditor({ projectPath, profile }: { projectPath: string; profile: EmployeeProfile | null }) {
  const { closeDialog, saveEmployee, deleteEmployee } = useStore.getState();
  const isNew = !profile;
  const [draft, setDraft] = useState<EmployeeProfile>(profile ?? blankProfile());
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    if (await saveEmployee(projectPath, draft, isNew)) closeDialog();
    setBusy(false);
  };
  return (
    <>
      <h2><Icon name="users" />{isNew ? '招一个新员工' : `「${profile.displayName}」的档案`}</h2>
      <p>档案存在项目里的 <code>.claude/agents/{draft.id || '<编号>'}.md</code>，长期记忆在 <code>.claude/agent-memory/{draft.id || '<编号>'}/</code>，都是项目资产。改了以后，新开的对话按新档案工作。</p>
      <ProfileForm value={draft} onChange={setDraft} isNew={isNew} />
      <div className="mfoot">
        {!isNew && <button className="btn ghost danger-text" onClick={() => { if (confirm(`删除「${profile.displayName}」的档案？\n他的对话和长期记忆会保留。`)) void deleteEmployee(projectPath, profile.id); }}>删除档案</button>}
        <span className="note" />
        <button className="btn" onClick={closeDialog}>取消</button>
        <button className="btn primary" data-testid="employee-save" disabled={busy || !draft.id || !draft.displayName.trim() || !draft.prompt.trim()} onClick={() => void save()}>{isNew ? '招聘' : '保存'}</button>
      </div>
    </>
  );
}

// ---------------- 对话里的卡片 ----------------

type TaskItem = Extract<Item, { kind: 'task' }>;
type ResultItem = Extract<Item, { kind: 'task-result' }>;

/** 员工的对话里：负责人派来的任务 */
export function TaskCard({ item }: { item: TaskItem }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="task-card" data-testid="task-card">
      <div className="tc-head" onClick={() => setOpen(!open)}>
        <Icon name="spark" size={14} /><b>任务 #{item.taskId}</b><span className="tc-title">{item.title}</span>
        <span className="tc-from">来自「{item.from}」</span><Icon name="right" size={13} className={`chev${open ? ' open' : ''}`} />
      </div>
      {open && <div className="tc-body"><Markdown text={item.text} /></div>}
    </div>
  );
}

/** 主对话里：员工交回的结果 */
export function ResultCard({ item }: { item: ResultItem }) {
  const task = useStore(s => s.tasks[item.taskId]);
  const openConversation = useStore(s => s.openConversation);
  const [open, setOpen] = useState(true);
  const failed = item.status === 'failed';
  return (
    <div className={`task-card result${failed ? ' failed' : ''}`} data-testid="task-result">
      <div className="tc-head" onClick={() => setOpen(!open)}>
        <Icon name={failed ? 'alert' : 'check'} size={14} /><b>{item.name} 交回 #{item.taskId}</b><span className="tc-title">{item.title}</span>
        {failed && <span className="tag fail">没做完</span>}
        <Icon name="right" size={13} className={`chev${open ? ' open' : ''}`} />
      </div>
      {open && (
        <div className="tc-body">
          <Markdown text={item.text} />
          {task && <button className="link sm" onClick={() => void openConversation(task.convId)}>打开 {item.name} 做这个活的对话</button>}
        </div>
      )}
    </div>
  );
}

/** 主对话里：派活的记录，实时显示员工做到哪了 */
export function AssignRow({ input, output, running }: { input: Record<string, unknown>; output?: string; running: boolean }) {
  const taskId = /任务 #(\d+)/.exec(output ?? '')?.[1];
  const task = useStore(s => (taskId ? s.tasks[taskId] : undefined));
  const openConversation = useStore(s => s.openConversation);
  const [open, setOpen] = useState(false);
  const who = task?.employeeName ?? String(input.employee ?? '');
  const state = !task ? (running ? '正在派活' : output ? '没派出去' : '') : task.status === 'running' ? '在做' : task.status === 'done' ? '已交回' : '没做完';
  return (
    <div className={`act${open ? ' open' : ''}`} data-testid="assign-row" data-task={taskId ?? ''}>
      <div className="act-head" onClick={() => setOpen(!open)}>
        <Icon name="users" size={14} />
        <span className={`verb${running ? ' shimmer' : ''}`}>{running ? '正在派活给' : '派给'}</span>
        <span className="obj">{who}：{String(input.title ?? '')}{taskId ? `（#${taskId}）` : ''}</span>
        {state && <span className={`tstate ${task?.status ?? ''}`}>{task?.status === 'running' && <i className="spin" />}{state}</span>}
        <Icon name="right" size={13} className="chev" />
      </div>
      {open && (
        <div className="act-body">
          <div className="box pad"><Markdown text={String(input.task ?? '')} /></div>
          {task && <button className="link sm" onClick={() => void openConversation(task.convId)}>打开 {who} 做这个活的对话</button>}
          {!task && output && <pre className="out">{output}</pre>}
        </div>
      )}
    </div>
  );
}
