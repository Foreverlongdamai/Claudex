// 自动化（C4）：审查队列（跑完、暂停、在跑的运行）、全部自动化，以及新建 / 修改的表单。
import { useEffect, useState } from 'react';
import { EFFORTS, type Automation, type AutomationRun, type Effort, type ModeId, type Schedule } from '@shared/types';
import { describeSchedule, describeWhen, parseTime, WEEKDAY_NAMES, type ScheduleKind } from '@shared/schedule';
import { MODES, MODE_ORDER } from '../modes';
import { useStore } from '../store';
import { Icon } from './Icon';
import { Modal } from './Dialogs';

const RUN_STATE: Record<AutomationRun['status'], string> = { running: '在跑', waiting: '暂停了，等你处理', done: '跑完了', failed: '没跑完' };
const TRIGGER: Record<AutomationRun['trigger'], string> = { schedule: '按计划', manual: '手动', catchup: '补跑' };
const KIND_LABEL: Record<ScheduleKind, string> = { daily: '每天', weekdays: '每个工作日', weekly: '每周', hourly: '每小时' };
const EFFORT_LABEL: Record<Effort, string> = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大' };
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const oneLine = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

/** 审查队列里要你看的：没处理过、而且不是还在跑的 */
export const needsReview = (r: AutomationRun) => !r.read && r.status !== 'running';

function RunIcon({ status }: { status: AutomationRun['status'] }) {
  if (status === 'running') return <i className="spin" />;
  return <Icon name={status === 'waiting' ? 'pause' : status === 'done' ? 'check' : 'alert'} size={14} />;
}

function QueueItem({ r }: { r: AutomationRun }) {
  const project = useStore(s => s.app?.projects.find(p => p.path === r.projectPath)?.name ?? baseName(r.projectPath));
  const { openRun, markRunRead } = useStore.getState();
  return (
    <div className={`qitem ${r.status}`} data-testid="queue-item" data-run={r.id} data-status={r.status}>
      <div className={`q-ic ${r.status}`}><RunIcon status={r.status} /></div>
      <div className="q-main">
        <b>{r.name}</b>
        <span>{project} · {describeWhen(r.startedAt)} · {TRIGGER[r.trigger]} · {RUN_STATE[r.status]}{r.summary ? `：${oneLine(r.summary, 160)}` : ''}</span>
      </div>
      {r.convId && <button className={`btn sm${r.status === 'waiting' ? ' primary' : ''}`} data-testid="queue-open" onClick={() => void openRun(r)}>{r.status === 'waiting' ? '去处理' : '查看'}</button>}
      {r.status !== 'running' && <button className="btn sm ghost" data-testid="queue-read" onClick={() => void markRunRead(r.id)}>{r.status === 'waiting' ? '忽略' : '标为已读'}</button>}
    </div>
  );
}

function AutomationRow({ a, runs }: { a: Automation; runs: AutomationRun[] }) {
  const project = useStore(s => s.app?.projects.find(p => p.path === a.projectPath)?.name ?? baseName(a.projectPath));
  const { setAutomationEnabled, runAutomation, deleteAutomation, openRun, deleteRun } = useStore.getState();
  const [open, setOpen] = useState(false);
  const mine = runs.filter(r => r.automationId === a.id).sort((x, y) => y.startedAt - x.startedAt);
  const last = mine[0];
  const busy = mine.some(r => r.status === 'running' || r.status === 'waiting');
  return (
    <>
      <tr data-testid="automation-row" data-automation={a.id}>
        <td><b>{a.name}</b><div className="td-sub" title={a.prompt}>{oneLine(a.prompt, 60)}</div></td>
        <td>{project}</td>
        <td>{describeSchedule(a.schedule)}<div className="td-sub">{a.enabled && a.nextRunAt ? `下次 ${describeWhen(a.nextRunAt)}` : '已停用'}</div></td>
        <td>{MODES[a.mode].label}<div className="td-sub">{a.place === 'worktree' ? '新 worktree' : '本地'}</div></td>
        <td>{last
          ? <button className={`st-link ${last.status}`} onClick={() => void openRun(last)} title="打开这次运行的对话"><RunIcon status={last.status} />{describeWhen(last.startedAt)}</button>
          : <span className="faint">还没运行</span>}</td>
        <td><button className={`mini-sw${a.enabled ? ' on' : ''}`} data-testid="automation-enabled" title={a.enabled ? '停用' : '启用'} onClick={() => void setAutomationEnabled(a.id, !a.enabled)} /></td>
        <td className="acts">
          <button className="link sm" data-testid="automation-run" disabled={busy} title={busy ? '上一次还没跑完' : ''} onClick={() => void runAutomation(a.id)}>现在跑一次</button>
          <button className="link sm" onClick={() => useStore.setState({ dialog: { kind: 'automation', automation: a } })}>修改</button>
          {mine.length > 0 && <button className="link sm" onClick={() => setOpen(!open)}>记录 {mine.length}</button>}
          <button className="link sm danger" onClick={() => { if (confirm(`删除自动化「${a.name}」？\n运行记录和它们的对话保留。`)) void deleteAutomation(a.id); }}>删除</button>
        </td>
      </tr>
      {open && (
        <tr className="runs-row"><td colSpan={7}>
          {mine.slice(0, 20).map(r => (
            <div className="run-line" key={r.id}>
              <span className={`st ${r.status}`}><RunIcon status={r.status} />{RUN_STATE[r.status]}</span>
              <span>{describeWhen(r.startedAt)} · {TRIGGER[r.trigger]}</span>
              <span className="run-sum">{r.summary ? oneLine(r.summary, 120) : ''}</span>
              {r.convId && <button className="link sm" onClick={() => void openRun(r)}>打开</button>}
              {r.status !== 'running' && <button className="link sm danger" title="删除这次运行的对话（worktree 里的改动先存到分支上）" onClick={() => { if (confirm('删除这次运行和它的对话？')) void deleteRun(r.id); }}>删除</button>}
            </div>
          ))}
        </td></tr>
      )}
    </>
  );
}

export function AutomationView() {
  const st = useStore(s => s.automation);
  const hasProjects = useStore(s => !!s.app?.projects.length);
  const { loadAutomations, setView } = useStore.getState();
  const [, tick] = useState(0);
  useEffect(() => { void loadAutomations(); }, [loadAutomations]);
  useEffect(() => { const t = setInterval(() => tick(x => x + 1), 30_000); return () => clearInterval(t); }, []); // 刷新“今天 08:00”这类说法
  const runs = st?.runs ?? [];
  const queue = runs.filter(r => !r.read).sort((a, b) => b.startedAt - a.startedAt);
  return (
    <div className="autoview" data-testid="automation-view">
      <div className="av-inner">
        <div className="av-head">
          <h1><Icon name="clock" size={18} />自动化</h1><span className="sp" />
          <button className="btn sm" onClick={() => setView('chat')}>回到对话</button>
          <button className="btn primary sm" data-testid="automation-new" disabled={!hasProjects} onClick={() => useStore.setState({ dialog: { kind: 'automation', automation: null } })}><Icon name="plus" size={14} />新建自动化</button>
        </div>
        <p className="av-sub">按计划让 Claude 自动跑任务。每次运行开一个新对话，默认在新的 worktree 里，不碰你本地的文件；跑完的结果进审查队列。关掉窗口 Claudex 会缩到托盘继续在后台运行，才能按时执行；App 没开时错过的，下次打开补跑一次。</p>
        <div className="av-sec">审查队列 <span className="cnt" data-testid="queue-count">{queue.filter(needsReview).length}</span></div>
        {queue.length === 0 ? <div className="q-empty">审查队列是空的。</div> : <div className="queue">{queue.map(r => <QueueItem key={r.id} r={r} />)}</div>}
        <div className="av-sec">全部自动化</div>
        {!st?.automations.length ? <div className="q-empty">还没有自动化。点右上角“新建自动化”，比如每天早上汇总昨晚跑完的实验、每周一检查依赖的安全更新。</div> : (
          <table className="tbl">
            <thead><tr><th>名称</th><th>项目</th><th>什么时候跑</th><th>模式</th><th>上次运行</th><th>启用</th><th /></tr></thead>
            <tbody>{st.automations.map(a => <AutomationRow key={a.id} a={a} runs={runs} />)}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---------------- 新建 / 修改 ----------------

export function AutomationForm({ automation }: { automation: Automation | null }) {
  const app = useStore(s => s.app)!;
  const models = useStore(s => s.models);
  const activeProject = useStore(s => s.activeProject);
  const { closeDialog, saveAutomation } = useStore.getState();
  const [name, setName] = useState(automation?.name ?? '');
  const [projectPath, setProjectPath] = useState(automation?.projectPath ?? activeProject ?? app.projects[0]?.path ?? '');
  const [prompt, setPrompt] = useState(automation?.prompt ?? '');
  const [kind, setKind] = useState<ScheduleKind>(automation?.schedule.kind ?? 'daily');
  const [time, setTime] = useState(automation?.schedule.time ?? '08:00');
  const [minute, setMinute] = useState(() => String(parseTime(automation?.schedule.time ?? '00:00')?.[1] ?? 0));
  const [weekday, setWeekday] = useState(automation?.schedule.weekday ?? 1);
  const [place, setPlace] = useState<Automation['place']>(automation?.place ?? 'worktree');
  const [mode, setMode] = useState<ModeId>(automation?.mode ?? 'bypassPermissions');
  const [model, setModel] = useState(automation?.model ?? app.prefs.defaultModel);
  const [effort, setEffort] = useState<Effort>(automation?.effort ?? app.prefs.defaultEffort);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const schedule = (): Schedule => (kind === 'hourly'
    ? { kind, time: `00:${String(Math.max(0, Math.min(59, Number(minute) || 0))).padStart(2, '0')}` }
    : { kind, time, ...(kind === 'weekly' ? { weekday } : {}) });
  const go = async (runNow: boolean) => {
    setBusy(true);
    setErr(null);
    const e = await saveAutomation({ id: automation?.id, name, projectPath, prompt, schedule: schedule(), place, mode, model, effort, enabled: automation?.enabled ?? true }, runNow);
    setBusy(false);
    if (e) setErr(e);
  };
  return (
    <Modal wide onClose={closeDialog}>
      <h2><Icon name="clock" />{automation ? `修改自动化「${automation.name}」` : '新建自动化'}</h2>
      <div className="form auto-form" data-testid="automation-form">
        <label>名称<input autoFocus value={name} placeholder="比如：每日实验汇总" data-testid="af-name" onChange={e => setName(e.target.value)} /></label>
        <label>项目<select value={projectPath} data-testid="af-project" onChange={e => setProjectPath(e.target.value)}>
          {app.projects.map(p => <option key={p.path} value={p.path}>{p.name}</option>)}
        </select></label>
        <label className="full">要 Claude 做什么<textarea rows={4} value={prompt} data-testid="af-prompt" placeholder="比如：汇总 runs/ 里昨晚跑完的实验，和基线对比，画一张曲线图，写一份简短的日报" onChange={e => setPrompt(e.target.value)} /></label>
        <label>什么时候跑<select value={kind} data-testid="af-kind" onChange={e => setKind(e.target.value as ScheduleKind)}>
          {(Object.keys(KIND_LABEL) as ScheduleKind[]).map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select></label>
        {kind === 'weekly' && <label>星期几<select value={weekday} onChange={e => setWeekday(Number(e.target.value))}>
          {WEEKDAY_NAMES.map((n, i) => <option key={i} value={i}>{n}</option>)}
        </select></label>}
        {kind === 'hourly'
          ? <label>每小时的第几分<input type="number" min={0} max={59} value={minute} data-testid="af-minute" onChange={e => setMinute(e.target.value)} /></label>
          : <label>时间<input type="time" value={time} data-testid="af-time" onChange={e => setTime(e.target.value)} /></label>}
        <label>在哪里跑<select value={place} data-testid="af-place" onChange={e => setPlace(e.target.value as Automation['place'])}>
          <option value="worktree">新 worktree（推荐，不碰本地文件）</option>
          <option value="local">本地项目文件夹</option>
        </select></label>
        <label>权限模式<select value={mode} data-testid="af-mode" onChange={e => setMode(e.target.value as ModeId)}>
          {MODE_ORDER.map(m => <option key={m} value={m}>{MODES[m].label}</option>)}
        </select></label>
        <label>模型<select value={model} onChange={e => setModel(e.target.value)}>
          {!models.some(m => m.value === model) && <option value={model}>{model}</option>}
          {models.map(m => <option key={m.value} value={m.value}>{m.displayName}</option>)}
        </select></label>
        <label>思考强度<select value={effort} onChange={e => setEffort(e.target.value as Effort)}>
          {EFFORTS.map(x => <option key={x} value={x}>{EFFORT_LABEL[x]}</option>)}
        </select></label>
      </div>
      <p className="form-note">现在会在 {describeSchedule(schedule())} 跑。{mode === 'bypassPermissions' ? '完全访问：改文件、运行命令都直接执行（保底黑名单照样拦截）。' : '没人看着的时候，遇到需要审批的操作，这次运行会暂停，进审查队列等你处理。'}{place === 'worktree' ? '每次运行在新的 worktree 里，结果可以在那次运行的对话里“接手到本地”。' : ''}</p>
      {err && <p className="field-err" data-testid="af-error">{err}</p>}
      <div className="mfoot">
        <button className="btn" onClick={closeDialog}>取消</button>
        <button className="btn" data-testid="af-save-run" disabled={busy} onClick={() => void go(true)}>保存并试跑一次</button>
        <button className="btn primary" data-testid="af-save" disabled={busy} onClick={() => void go(false)}>保存</button>
      </div>
    </Modal>
  );
}
